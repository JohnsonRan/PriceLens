importScripts("shared.js", "jev.js");

const { CURRENCIES, ECB_CURRENCIES, settingsFrom } = PriceLens;
const localReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
const inFlight = new Map();
const failures = new Map();
let credentialRevision = 0;
let settingsRevision = 0;
let saveQueue = Promise.resolve();
const TTL = { wise: 5 * 60_000, ecb: 6 * 60 * 60_000 };
const MAX_STALE = 7 * 24 * 60 * 60_000;

async function getSettings() {
  await localReady;
  const [synced, local] = await Promise.all([chrome.storage.sync.get(null), chrome.storage.local.get(["jevEnabled", "jevSavingsEnabled"])]);
  return settingsFrom({ ...synced, jevEnabled: local.jevEnabled === true, jevSavingsEnabled: local.jevSavingsEnabled === true });
}

async function inferJev(message, sender) {
  const revision = settingsRevision;
  await saveQueue;
  const settings = await getSettings();
  let url;
  try { url = new URL(sender.url); } catch { throw new Error("Jev 仅处理普通网页候选。"); }
  if (!settings.enabled || !settings.jevEnabled || settings.excludedHosts.includes(url.hostname)) throw new Error("Jev 辅助识别未开启或当前网站已暂停。");
  if (!/^https?:$/.test(url.protocol) || /(?:checkout|payment|account|login|orders?|cart)(?:[/.?_-]|$)/i.test(url.pathname)) throw new Error("此页面不发送 AI 请求。");
  if (!await chrome.permissions.contains({ origins: ["https://api.typesafe.ai/*"] })) throw new Error("尚未授权访问 Jev 服务。");
  const { jevKey } = await chrome.storage.local.get("jevKey");
  if (!jevKey) throw new Error("请先配置 Jev API Key。");
  // No await between this check and infer's fetch: a revoked task must never start an upload.
  if (revision !== settingsRevision) throw new Error("识别设置已改变，本次请求已取消。");
  const decisions = await PriceLensJev.infer(message.candidates, jevKey);
  const current = await getSettings();
  if (revision !== settingsRevision || !current.enabled || !current.jevEnabled || current.excludedHosts.includes(url.hostname)) throw new Error("识别设置已改变，本次结果已丢弃。");
  return { decisions };
}

function readTable(rows, provider, target) {
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error("汇率接口返回了无效数据。");
  const rates = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const source = provider === "wise" ? row.target : row.quote;
    const base = provider === "wise" ? row.source : row.base;
    const asOf = provider === "wise" ? row.time : row.date;
    const time = typeof asOf === "string" ? Date.parse(asOf) : NaN;
    if (base !== target || !Object.hasOwn(CURRENCIES, source)) continue;
    if (typeof row.rate !== "number" || !Number.isFinite(row.rate) || row.rate <= 0 || !Number.isFinite(time) || time > Date.now() + 24 * 60 * 60_000 || Date.now() - time > MAX_STALE) continue;
    rates[source] = { rate: row.rate, asOf };
  }
  if (!Object.keys(rates).some((code) => code !== target)) throw new Error("没有可用汇率，或报价日期已超过 7 天。");
  return { provider, target, rates, fetchedAt: Date.now(), stale: false };
}

async function download(provider, target, token) {
  if (provider === "wise" && !token) throw new Error("请先在插件中配置自己的 Wise API Token。");
  if (provider === "wise" && !await chrome.permissions.contains({ origins: ["https://api.wise.com/*"] })) throw new Error("请在设置中授权访问 Wise 服务。");
  if (provider === "ecb" && !ECB_CURRENCIES.includes(target)) throw new Error("ECB 不支持此目标币种，请改用 Wise 或选择其他币种。");
  const url = provider === "wise"
    ? `https://api.wise.com/2026Q3/rates?source=${target}`
    : `https://api.frankfurter.dev/v2/providers/ecb/rates?base=${target}`;
  let response;
  try {
    response = await fetch(url, {
      headers: provider === "wise" ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(12_000), credentials: "omit", redirect: "error", cache: "no-store",
    });
  } catch {
    throw new Error("汇率请求失败或超时，请检查网络后重试。");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("Wise Token 无效或无权访问汇率接口，请检查权限。");
    if (response.status === 429) throw new Error("汇率服务限流，请稍后重试。");
    throw new Error(`汇率服务暂不可用（HTTP ${response.status}）。`);
  }
  let rows;
  try { rows = await response.json(); } catch { throw new Error("汇率接口返回了无效 JSON。"); }
  return readTable(rows, provider, target);
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
      if (revision !== credentialRevision) throw new Error("设置已更新，请重新获取汇率。");
      await chrome.storage.local.set({ [key]: table });
      failures.delete(key);
      return table;
    } catch (error) {
      if (revision !== credentialRevision) throw new Error("设置已更新，请重新获取汇率。");
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
  if (!input || !Object.hasOwn(CURRENCIES, input.target) || !["wise", "ecb"].includes(input.provider) || typeof input.enabled !== "boolean" || !(input.sourceHint === "" || Object.hasOwn(CURRENCIES, input.sourceHint)) || !Array.isArray(input.excludedHosts)) throw new Error("设置无效。");
  if (input.provider === "ecb" && !ECB_CURRENCIES.includes(input.target)) throw new Error("此币种需使用 Wise。");
  await localReady;
  const stored = await chrome.storage.local.get(["wiseToken", "jevKey", "jevEnabled", "jevSavingsEnabled"]);
  const token = message.token === null ? stored.wiseToken || "" : message.token;
  const jevKey = message.jevKey == null ? stored.jevKey || "" : message.jevKey;
  if (typeof jevKey !== "string" || jevKey.length > 4096 || /[^\x21-\x7e]/.test(jevKey)) throw new Error("Jev Key 格式无效。");
  if (input.jevEnabled === true && (!jevKey || !await chrome.permissions.contains({ origins: ["https://api.typesafe.ai/*"] }))) throw new Error("开启 Jev 需要 Key 和服务访问授权。");
  if (typeof token !== "string" || token.length > 4096 || /[^\x21-\x7e]/.test(token)) throw new Error("Token 格式无效，请勿输入空格或换行。");
  if (input.provider === "wise" && !token) throw new Error("使用 Wise 前请填写 API Token。");
  if (input.provider === "wise" && !await chrome.permissions.contains({ origins: ["https://api.wise.com/*"] })) throw new Error("使用 Wise 前请授权服务访问。");
  if (token !== (stored.wiseToken || "")) {
    credentialRevision++;
    failures.clear();
    inFlight.clear();
    const local = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(local).filter((key) => key.startsWith("rates:wise:")));
    if (token) await chrome.storage.local.set({ wiseToken: token });
    else await chrome.storage.local.remove("wiseToken");
  }
  const settings = settingsFrom(input);
  await chrome.storage.local.set({ jevEnabled: settings.jevEnabled, jevSavingsEnabled: settings.jevSavingsEnabled });
  if (jevKey) await chrome.storage.local.set({ jevKey });
  else await chrome.storage.local.remove("jevKey");
  const { jevEnabled, jevSavingsEnabled, ...synced } = settings;
  await chrome.storage.sync.set(synced);
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
      case "getRates": return { table: await getRates(trusted && message.force === true) };
      case "inferJev": return inferJev(message, sender);
      case "inferJevSavings": throw new Error("此版本不提供参考标价差。");
      case "saveSettings": {
        if (!trusted) throw new Error("仅插件设置页可修改设置。");
        // Serialize the entire read/modify/write, including credential snapshots.
        const saving = saveQueue.then(() => {
          settingsRevision++;
          PriceLensJev.reset();
          return saveSettings(message);
        });
        saveQueue = saving.catch(() => {});
        return saving;
      }
      default: throw new Error("未知请求。");
    }
  };
  handle().then((data) => sendResponse({ ok: true, ...data }), (error) => sendResponse({ ok: false, error: error.message || "操作失败。" }));
  return true;
});
