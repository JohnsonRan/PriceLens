const C = PriceLens;
const $ = (id) => document.getElementById(id);
let state;
let activeTab;
let hostname = "";
let dirty = false;
let baseline = ""; // Settings form values as last loaded or saved.
let noticeTimer;
// Dirty means "differs from what is saved", so changing a setting and changing it back is clean again.
const formState = () => JSON.stringify([...($("settings-form").elements ?? [])].filter((el) => el.type !== "submit" && el.type !== "button").map((el) => el.type === "checkbox" ? el.checked : el.value));
let busy = false;
let rates = null; // Last loaded table, for the quick converter.

async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || C.t("errNoBackground"));
  return result;
}

function notice(text, error = false, tone = "success") {
  clearTimeout(noticeTimer);
  $("notice").textContent = text;
  $("notice").dataset.error = String(error);
  $("notice").dataset.tone = error ? "error" : tone;
  // A success message is a confirmation, not state: let it (and the save bar) go away.
  if (text && !error && tone === "success") noticeTimer = setTimeout(() => { if (!dirty) notice(""); }, 2500);
}

function controls() {
  $("save").disabled = busy || !state || !dirty;
  $("refresh").disabled = busy || !state || dirty;
}

function providerUI() {
  const wise = $("provider").value === "wise";
  $("provider-hint").textContent = wise ? C.t("providerHintWise") : C.t("providerHintFree");
  $("credentials").hidden = !wise && !state?.hasToken;
  $("credentials").open = wise && !state?.hasToken;
  $("token-state").textContent = state?.hasToken ? C.t("stateSaved") : C.t("stateMissing");
  $("token").placeholder = state?.hasToken ? C.t("placeholderReplace") : C.t("placeholderToken");
  $("clear-token-row").hidden = !state?.hasToken;
}

function aiUI() {
  $("jev-enabled").checked = state.settings.jevEnabled;
  $("jev-state").textContent = state.settings.jevEnabled ? C.t("stateOn") : C.t("stateOff");
  $("jev-key").placeholder = state.hasJevKey ? C.t("placeholderReplace") : C.t("placeholderJevKey");
  $("clear-jev-row").hidden = !state.hasJevKey;
  $("jev-status").textContent = state.jevStatus?.message || C.t("jevIdle");
  $("jev-status").dataset.error = String(state.jevStatus?.state === "error");
  const siteHint = C.siteHintFor(state.settings, hostname);
  $("recognition-hint").textContent = siteHint ? C.t("recognitionSite", siteHint)
    : state.settings.sourceHint ? C.t("recognitionManual", state.settings.sourceHint)
    : state.settings.jevEnabled ? C.t("recognitionAi") : C.t("recognitionLocal");
  $("privacy-state").textContent = state.settings.jevEnabled ? C.t("footerAiOn") : "";
  $("footer-estimate").textContent = state.settings.feePercent ? C.t("footerEstimateFee", state.settings.feePercent) : C.t("footerEstimate");
}

function calc() {
  const raw = $("calc-amount").value, from = $("calc-from").value, amount = Number(raw);
  // Reference rate for the ticket: scale small units (JPY, KRW…) so the figure stays readable.
  let base = 1;
  while (rates && from !== rates.target && C.convert(base, from, rates, 0) < 1 && base < 1e6) base *= 10;
  const unit = rates && from !== rates.target ? C.convert(base, from, rates, 0) : null;
  $("calc-rate").textContent = unit === null ? "" : `${base.toLocaleString(C.uiLocale())} ${from} ≈ ${C.formatMoney(unit, rates.target)}`;
  if (!rates || !raw || !(amount >= 0)) { $("calc-result").textContent = ""; return; }
  const same = from === rates.target, fee = same ? 0 : state.settings.feePercent;
  const value = same ? amount : C.convert(amount, from, rates, fee);
  $("calc-result").textContent = value === null ? C.t("calcNoRate", from) : `≈ ${C.formatMoney(value, rates.target)}`;
  if (value !== null && fee) $("calc-result").append(Object.assign(document.createElement("small"), { textContent: ` · ${C.t("feeShort", fee)}` }));
}

async function notifyPage() {
  if (activeTab?.id) await chrome.tabs.sendMessage(activeTab.id, { type: "refresh" }).catch(() => {});
}

async function showRates(force = false) {
  $("status-title").textContent = C.t("statusLoading");
  $("source-badge").textContent = state.settings.provider === "wise" ? "WISE" : C.t("badgeCentralBank");
  $("status-detail").textContent = "";
  try {
    rates = null;
    const { table } = await request({ type: "getRates", force });
    rates = table;
    const dates = Object.values(table.rates).map((r) => r.asOf).sort();
    const range = dates[0] === dates.at(-1) ? dates[0] : `${dates[0]} — ${dates.at(-1)}`;
    document.querySelector(".rate-status").dataset.warning = String(table.stale);
    $("status-title").textContent = (table.stale ? C.t("statusCachedPrefix") : "") + C.t("statusQuoteDate", dates.at(-1)?.slice(0, 10) || C.t("statusNone"));
    const count = Object.keys(table.rates).filter((code) => code !== table.target).length;
    const blended = Object.entries(table.rates).filter(([, r]) => r.source === "blend").map(([code]) => code);
    $("status-detail").textContent = [C.t("detailTarget", table.target, count), ...(blended.length ? [C.t("detailBlend", blended.join(" "))] : []), C.t("detailQuoted", range), C.t("detailFetched", new Date(table.fetchedAt).toLocaleString(C.uiLocale())), ...(table.stale ? [table.warning] : [])].join("\n");
  } catch (error) {
    document.querySelector(".rate-status").dataset.warning = "true";
    $("status-title").textContent = C.t("statusUnavailable");
    $("status-detail").textContent = `${error.message}\n${C.t("detailFailClosed")}`;
  } finally { calc(); }
}

// The quick converter lives in the form for layout only; it never makes settings dirty or submits them.
$("calc-amount").addEventListener("keydown", (event) => { if (event.key === "Enter") event.preventDefault(); });
for (const id of ["calc-amount", "calc-from"]) $(id).addEventListener("input", (event) => { event.stopPropagation(); calc(); });
$("settings-form").addEventListener("input", () => {
  dirty = formState() !== baseline;
  if (dirty) notice(C.t("noticeUnsaved"), false, "pending");
  else if ($("notice").dataset.tone === "pending") notice("");
  controls();
});
$("provider").addEventListener("change", providerUI);
$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !state) return;
  busy = true;
  controls();
  try {
    if ($("jev-enabled").checked && ($("clear-jev").checked || (!$("jev-key").value.trim() && !state.hasJevKey))) throw new Error(C.t("errJevKeyFirst"));
    if ($("provider").value === "wise" && ($("clear-token").checked || (!$("token").value.trim() && !state.hasToken))) throw new Error(C.t("errWiseNeedsToken"));
    const origins = [];
    if ($("jev-enabled").checked) origins.push("https://api.typesafe.ai/*");
    if ($("provider").value === "wise") origins.push("https://api.wise.com/*");
    if (origins.length && !await chrome.permissions.request({ origins })) throw new Error(C.t("errPermissionDenied"));
    const excluded = new Set(state.settings.excludedHosts);
    const siteHints = { ...state.settings.siteHints };
    if (hostname) {
      if ($("pause-site").checked) excluded.add(hostname);
      else excluded.delete(hostname);
      if ($("site-hint").value) siteHints[hostname] = $("site-hint").value;
      else delete siteHints[hostname];
    }
    state = await request({
      type: "saveSettings",
      settings: { enabled: $("enabled").checked, savingsEnabled: $("savings-enabled").checked, target: $("target").value, provider: $("provider").value, sourceHint: $("source-hint").value, excludedHosts: [...excluded], siteHints, feePercent: Number($("fee").value) || 0, jevEnabled: $("jev-enabled").checked },
      token: $("clear-token").checked ? "" : $("token").value.trim() || null,
      jevKey: $("clear-jev").checked ? "" : $("jev-key").value.trim() || null,
    });
    $("token").value = "";
    $("clear-token").checked = false;
    $("jev-key").value = "";
    $("clear-jev").checked = false;
    dirty = false;
    providerUI();
    aiUI();
    baseline = formState();
    notice(C.t("noticeSaved"));
    await showRates();
    await notifyPage();
  } catch (error) {
    notice(error.message, true);
  } finally { busy = false; controls(); }
});
$("refresh").addEventListener("click", async () => {
  if (busy || dirty) return;
  busy = true;
  controls();
  try { await showRates(true); await notifyPage(); }
  finally { busy = false; controls(); }
});

(async () => {
  busy = true;
  document.documentElement.lang = C.t("htmlLang"); // The resolved locale pack, not the browser language.
  $("version").textContent = `v${chrome.runtime.getManifest().version}`;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = C.t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = C.t(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll("[data-i18n-aria-label]")) el.setAttribute("aria-label", C.t(el.dataset.i18nAriaLabel));
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = C.t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll("[data-i18n-href]")) el.href = C.t(el.dataset.i18nHref);
  for (const code of Object.keys(C.CURRENCIES)) {
    $("target").add(new Option(`${code} · ${C.currencyName(code)}`, code));
    $("source-hint").add(new Option(`${code} · ${C.currencyName(code)}`, code));
    $("site-hint").add(new Option(`${code} · ${C.currencyName(code)}`, code));
    $("calc-from").add(new Option(code, code));
  }
  try {
    const results = await Promise.all([request({ type: "getState" }), chrome.tabs.query({ active: true, currentWindow: true })]);
    state = results[0];
    activeTab = results[1][0];
    if (activeTab?.url && /^https?:/.test(activeTab.url)) hostname = new URL(activeTab.url).hostname;
    $("enabled").checked = state.settings.enabled;
    $("target").value = state.settings.target;
    $("provider").value = state.settings.provider;
    $("source-hint").value = state.settings.sourceHint;
    $("site-hint").value = C.siteHintFor(state.settings, hostname);
    $("site-hint").disabled = !hostname;
    $("site-hint-host").textContent = hostname;
    $("fee").value = String(state.settings.feePercent);
    $("calc-from").value = state.settings.target === "USD" ? "EUR" : "USD";
    $("savings-enabled").checked = state.settings.savingsEnabled;
    $("pause-site").disabled = !hostname;
    $("pause-site").checked = state.settings.excludedHosts.includes(hostname);
    $("site-name").textContent = hostname || C.t("siteBuiltin");
    providerUI();
    aiUI();
    baseline = formState();
    await showRates();
  } catch (error) {
    notice(error.message, true);
    $("status-title").textContent = C.t("statusConnectFailed");
    document.querySelector(".rate-status").dataset.warning = "true";
  } finally { busy = false; controls(); }
})();
