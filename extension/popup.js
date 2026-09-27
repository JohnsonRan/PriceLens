const C = PriceLens;
const $ = (id) => document.getElementById(id);
let state;
let activeTab;
let hostname = "";
let dirty = false;
let busy = false;

async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || C.t("errNoBackground"));
  return result;
}

function notice(text, error = false, tone = "success") {
  $("notice").textContent = text;
  $("notice").dataset.error = String(error);
  $("notice").dataset.tone = error ? "error" : tone;
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
  $("recognition-hint").textContent = state.settings.sourceHint
    ? C.t("recognitionManual", state.settings.sourceHint)
    : state.settings.jevEnabled ? C.t("recognitionAi") : C.t("recognitionLocal");
  $("privacy-state").textContent = state.settings.jevEnabled ? C.t("footerAiOn") : "";
}

async function notifyPage() {
  if (activeTab?.id) await chrome.tabs.sendMessage(activeTab.id, { type: "refresh" }).catch(() => {});
}

async function showRates(force = false) {
  $("status-title").textContent = C.t("statusLoading");
  $("source-badge").textContent = state.settings.provider === "wise" ? "WISE" : C.t("badgeCentralBank");
  $("status-detail").textContent = "";
  try {
    const { table } = await request({ type: "getRates", force });
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
  }
}

$("settings-form").addEventListener("input", () => { dirty = true; notice(C.t("noticeUnsaved"), false, "pending"); controls(); });
$("provider").addEventListener("change", providerUI);
$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !state) return;
  busy = true;
  controls();
  try {
    if ($("jev-enabled").checked && ($("clear-jev").checked || (!$("jev-key").value.trim() && !state.hasJevKey))) throw new Error(C.t("errJevKeyFirst"));
    const origins = [];
    if ($("jev-enabled").checked) origins.push("https://api.typesafe.ai/*");
    if ($("provider").value === "wise") origins.push("https://api.wise.com/*");
    if (origins.length && !await chrome.permissions.request({ origins })) throw new Error(C.t("errPermissionDenied"));
    const excluded = new Set(state.settings.excludedHosts);
    if (hostname) {
      if ($("pause-site").checked) excluded.add(hostname);
      else excluded.delete(hostname);
    }
    state = await request({
      type: "saveSettings",
      settings: { enabled: $("enabled").checked, savingsEnabled: $("savings-enabled").checked, target: $("target").value, provider: $("provider").value, sourceHint: $("source-hint").value, excludedHosts: [...excluded], jevEnabled: $("jev-enabled").checked },
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
  document.documentElement.lang = C.uiLocale();
  $("version").textContent = `v${chrome.runtime.getManifest().version}`;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = C.t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = C.t(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll("[data-i18n-aria-label]")) el.setAttribute("aria-label", C.t(el.dataset.i18nAriaLabel));
  for (const code of Object.keys(C.CURRENCIES)) {
    $("target").add(new Option(`${code} · ${C.currencyName(code)}`, code));
    $("source-hint").add(new Option(`${code} · ${C.currencyName(code)}`, code));
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
    $("savings-enabled").checked = state.settings.savingsEnabled;
    $("pause-site").disabled = !hostname;
    $("pause-site").checked = state.settings.excludedHosts.includes(hostname);
    $("site-name").textContent = hostname || C.t("siteBuiltin");
    providerUI();
    aiUI();
    await showRates();
  } catch (error) {
    notice(error.message, true);
    $("status-title").textContent = C.t("statusConnectFailed");
    document.querySelector(".rate-status").dataset.warning = "true";
  } finally { busy = false; controls(); }
})();
