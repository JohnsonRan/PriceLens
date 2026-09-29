importScripts("shared.js", "jev.js");

const { CURRENCIES, ECB_CURRENCIES, settingsFrom, isSensitivePath, t } = PriceLens;
// If a browser rejects this, keep working: only this extension's own content script could then read local storage.
const localReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
const inFlight = new Map();
const failures = new Map();
let credentialRevision = 0;
let settingsRevision = 0;
let saveQueue = Promise.resolve();
const TTL = { wise: 5 * 60_000, ecb: 6 * 60 * 60_000 };
const MAX_STALE = 7 * 24 * 60 * 60_000;

async function getSettings() {
  await localReady;
  const [synced, local] = await Promise.all([chrome.storage.sync.get(null), chrome.storage.local.get("jevEnabled")]);
  return settingsFrom({ ...synced, jevEnabled: local.jevEnabled === true });
}

async function inferJev(message, sender) {
  const revision = settingsRevision;
  await saveQueue;
  const settings = await getSettings();
  let url;
  try { url = new URL(sender.url); } catch { throw new Error(t("errJevPageOnly")); }
  if (!settings.enabled || !settings.jevEnabled || settings.excludedHosts.includes(url.hostname)) throw new Error(t("errJevOff"));
  if (!/^https?:$/.test(url.protocol) || isSensitivePath(url.pathname + url.hash)) throw new Error(t("errAiSensitive"));
  if (!await chrome.permissions.contains({ origins: ["https://api.typesafe.ai/*"] })) throw new Error(t("errJevPermission"));
  const { jevKey } = await chrome.storage.local.get("jevKey");
  if (!jevKey) throw new Error(t("errJevKeyMissing"));
  // No await between this check and infer's fetch: a revoked task must never start an upload.
  if (revision !== settingsRevision) throw new Error(t("errJevCancelled"));
  const decisions = await PriceLensJev.infer(message.candidates, jevKey);
  const current = await getSettings();
  if (revision !== settingsRevision || !current.enabled || !current.jevEnabled || current.excludedHosts.includes(url.hostname)) throw new Error(t("errJevDiscarded"));
  return { decisions };
}

// Rows -> { CODE: { rate, asOf, source } }, keeping only requested, fresh, positive quotes.
function readRates(rows, target, source, wanted) {
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error(t("errRatesInvalid"));
  const rates = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const quote = source === "wise" ? row.target : row.quote;
    const base = source === "wise" ? row.source : row.base;
    const asOf = source === "wise" ? row.time : row.date;
    const time = typeof asOf === "string" ? Date.parse(asOf) : NaN;
    if (base !== target || !wanted.includes(quote)) continue;
    if (typeof row.rate !== "number" || !Number.isFinite(row.rate) || row.rate <= 0 || !Number.isFinite(time) || time > Date.now() + 24 * 60 * 60_000 || Date.now() - time > MAX_STALE) continue;
    rates[quote] = { rate: row.rate, asOf, source };
  }
  return rates;
}

async function request(url, headers = {}) {
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(12_000), credentials: "omit", redirect: "error", cache: "no-store" });
  } catch {
    throw new Error(t("errRatesNetwork"));
  }
  if (!response.ok) {
    if ((response.status === 401 || response.status === 403) && headers.Authorization) throw new Error(t("errWiseAuth"));
    if (response.status === 429) throw new Error(t("errRatesLimited"));
    throw new Error(t("errRatesHttp", response.status));
  }
  try { return await response.json(); } catch { throw new Error(t("errRatesJson")); }
}

async function download(provider, target, token) {
  const others = Object.keys(CURRENCIES).filter((code) => code !== target);
  const rates = {};
  let error;
  if (provider === "wise") {
    if (!token) throw new Error(t("errWiseTokenMissing"));
    if (!await chrome.permissions.contains({ origins: ["https://api.wise.com/*"] })) throw new Error(t("errWisePermission"));
    Object.assign(rates, readRates(await request(`https://api.wise.com/2026Q3/rates?source=${target}`, { Authorization: `Bearer ${token}` }), target, "wise", others));
  } else {
    // Prefer one traceable official source (ECB); fill only its gaps with Frankfurter's multi-central-bank blend.
    if (ECB_CURRENCIES.includes(target)) {
      try { Object.assign(rates, readRates(await request(`https://api.frankfurter.dev/v2/providers/ecb/rates?base=${target}`), target, "ecb", others)); } catch (e) { error = e; }
    }
    const missing = others.filter((code) => !rates[code]);
    if (missing.length) {
      try { Object.assign(rates, readRates(await request(`https://api.frankfurter.dev/v2/rates?base=${target}&quotes=${missing.join(",")}`), target, "blend", missing)); } catch (e) { error ??= e; }
    }
  }
  if (!Object.keys(rates).length) throw error || new Error(t("errRatesNone"));
  return { provider, target, rates, fetchedAt: Date.now(), stale: false };
}

async function getRates(force = false) {
  await localReady;
  const { provider, target } = await getSettings();
  const key = `rates:${provider}:${target}`;
  const saved = await chrome.storage.local.get([key, "wiseToken"]);
  const cached = saved[key];
  const age = Date.now() - (cached?.fetchedAt || 0);
  const quotes = cached?.rates && typeof cached.rates === "object" && !Array.isArray(cached.rates) ? Object.entries(cached.rates) : [];
  const usableCache = cached?.provider === provider && cached?.target === target && age >= 0 && age <= MAX_STALE && quotes.some(([code]) => code !== target) && quotes.every(([code, r]) => {
    const quoteAge = Date.now() - Date.parse(r?.asOf);
    return Object.hasOwn(CURRENCIES, code) && typeof r?.rate === "number" && Number.isFinite(r.rate) && r.rate > 0 && quoteAge >= -86_400_000 && quoteAge <= MAX_STALE;
  });
  if (inFlight.has(key)) return inFlight.get(key);
  const failure = failures.get(key);
  if (failure && Date.now() - failure.at < 30_000) return fallback(failure.message);
  if (!force && usableCache && age < TTL[provider]) return cached;
  const revision = credentialRevision;
  const request = (async () => {
    try {
      const table = await download(provider, target, saved.wiseToken);
      if (revision !== credentialRevision) throw new Error(t("errSettingsChanged"));
      await chrome.storage.local.set({ [key]: table });
      failures.delete(key);
      return table;
    } catch (error) {
      if (revision !== credentialRevision) throw new Error(t("errSettingsChanged"));
      failures.set(key, { at: Date.now(), message: error.message });
      return fallback(error.message);
    } finally {
      if (inFlight.get(key) === request) inFlight.delete(key);
    }
  })();
  inFlight.set(key, request);
  return request;

  function fallback(message) {
    if (usableCache) return { ...cached, stale: true, warning: message };
    throw new Error(message);
  }
}

async function saveSettings(message) {
  const input = message.settings;
  if (!input || !Object.hasOwn(CURRENCIES, input.target) || !["wise", "ecb"].includes(input.provider) || typeof input.enabled !== "boolean" || typeof input.savingsEnabled !== "boolean" || !(input.sourceHint === "" || Object.hasOwn(CURRENCIES, input.sourceHint)) || !Array.isArray(input.excludedHosts)) throw new Error(t("errSettingsInvalid"));
  if (input.excludedHosts.length > 200) throw new Error(t("errTooManyHosts"));
  await localReady;
  const stored = await chrome.storage.local.get(["wiseToken", "jevKey"]);
  const token = message.token === null ? stored.wiseToken || "" : message.token;
  const jevKey = message.jevKey == null ? stored.jevKey || "" : message.jevKey;
  if (typeof jevKey !== "string" || jevKey.length > 4096 || /[^\x21-\x7e]/.test(jevKey)) throw new Error(t("errJevKeyFormat"));
  if (input.jevEnabled === true && (!jevKey || !await chrome.permissions.contains({ origins: ["https://api.typesafe.ai/*"] }))) throw new Error(t("errJevNeedsKey"));
  if (typeof token !== "string" || token.length > 4096 || /[^\x21-\x7e]/.test(token)) throw new Error(t("errTokenFormat"));
  if (input.provider === "wise" && !token) throw new Error(t("errWiseNeedsToken"));
  if (input.provider === "wise" && !await chrome.permissions.contains({ origins: ["https://api.wise.com/*"] })) throw new Error(t("errWiseNeedsPermission"));
  // Write synced settings first: sync is the write that can fail (quota/rate), and must not leave AI consent half-applied.
  const settings = settingsFrom(input);
  const { jevEnabled, ...synced } = settings;
  await chrome.storage.sync.remove("jevSavingsEnabled");
  await chrome.storage.sync.set(synced);
  if (token !== (stored.wiseToken || "")) {
    credentialRevision++;
    failures.clear();
    inFlight.clear();
    const local = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(local).filter((key) => key.startsWith("rates:wise:")));
    if (token) await chrome.storage.local.set({ wiseToken: token });
    else await chrome.storage.local.remove("wiseToken");
  }
  await chrome.storage.local.set({ jevEnabled });
  await chrome.storage.local.remove("jevSavingsEnabled"); // Retired 0.1 experiment flag.
  if (jevKey) await chrome.storage.local.set({ jevKey });
  else await chrome.storage.local.remove("jevKey");
  // AI consent is device-local, so notify tabs explicitly instead of relying on sync events.
  chrome.tabs.query({}).then((tabs) => Promise.allSettled(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: "refresh", resetJev: true })))).catch(() => {});
  return { settings, hasToken: Boolean(token), hasJevKey: Boolean(jevKey), jevStatus: PriceLensJev.getStatus() };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const trusted = sender.url === chrome.runtime.getURL("popup.html");
  const handle = async () => {
    await localReady;
    switch (message?.type) {
      case "getState": {
        const state = { settings: await getSettings() };
        if (trusted) {
          const local = await chrome.storage.local.get(["wiseToken", "jevKey"]);
          state.hasToken = Boolean(local.wiseToken);
          state.hasJevKey = Boolean(local.jevKey);
          state.jevStatus = PriceLensJev.getStatus();
        }
        return state;
      }
      case "getStyles": return { css: await (await fetch(chrome.runtime.getURL("content.css"))).text() };
      case "getRates": return { table: await getRates(trusted && message.force === true) };
      case "inferJev": return inferJev(message, sender);
      case "saveSettings": {
        if (!trusted) throw new Error(t("errPopupOnly"));
        // Serialize the entire read/modify/write, including credential snapshots.
        const saving = saveQueue.then(() => {
          settingsRevision++;
          PriceLensJev.reset();
          return saveSettings(message);
        });
        saveQueue = saving.catch(() => {});
        return saving;
      }
      default: throw new Error(t("errUnknownRequest"));
    }
  };
  handle().then((data) => sendResponse({ ok: true, ...data }), (error) => sendResponse({ ok: false, error: error.message || t("errGeneric") }));
  return true;
});
