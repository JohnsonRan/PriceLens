const C = PriceLens;
const $ = (id) => document.getElementById(id);
let state;
let activeTab;
let hostname = "";
let dirty = false;
let busy = false;

async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "无法连接插件后台，请重新加载扩展。");
  return result;
}

function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").dataset.error = String(error);
}

function controls() {
  $("save").disabled = busy || !state || !dirty;
  $("refresh").disabled = busy || !state || dirty;
}

function providerUI() {
  const wise = $("provider").value === "wise";
  $("provider-hint").textContent = wise ? "使用你的 Token，按需查询中间价。" : "免费日更参考值，不是实时汇率。";
  for (const option of $("target").options) option.disabled = !wise && !C.ECB_CURRENCIES.includes(option.value);
  $("credentials").hidden = !wise && !state?.hasToken;
  $("credentials").open = wise && !state?.hasToken;
  $("token-state").textContent = state?.hasToken ? "· 已保存" : "· 未配置";
  $("token").placeholder = state?.hasToken ? "已保存；留空保留，输入可替换" : "粘贴你自己的 Token";
  $("clear-token-row").hidden = !state?.hasToken;
}

function aiUI() {
  $("jev-enabled").checked = state.settings.jevEnabled;
  $("jev-state").textContent = state.settings.jevEnabled ? "· 已开启" : "· 关闭";
  $("jev-key").placeholder = state.hasJevKey ? "已保存；留空保留，输入可替换" : "仅保存在本机，不会同步";
  $("clear-jev-row").hidden = !state.hasJevKey;
  $("jev-status").textContent = state.jevStatus?.message || "尚未调用模型";
  $("jev-status").dataset.error = String(state.jevStatus?.state === "error");
  $("recognition-hint").textContent = state.settings.sourceHint
    ? `${state.settings.sourceHint} 仅补歧义符号，全局生效；明确币种优先。`
    : state.settings.jevEnabled ? "优先本地识别，AI 辅助疑难币种；不确定时跳过。" : "使用页面币种信息；不确定时跳过。";
  $("privacy-state").textContent = state.settings.jevEnabled ? "AI 已开启" : "";
}

async function notifyPage() {
  if (activeTab?.id) await chrome.tabs.sendMessage(activeTab.id, { type: "refresh" }).catch(() => {});
}

async function showRates(force = false) {
  $("status-title").textContent = "正在获取汇率…";
  $("source-badge").textContent = state.settings.provider === "wise" ? "WISE" : "ECB · 日更";
  $("status-detail").textContent = "";
  try {
    const { table } = await request({ type: "getRates", force });
    const dates = Object.values(table.rates).map((r) => r.asOf).sort();
    const range = dates[0] === dates.at(-1) ? dates[0] : `${dates[0]} — ${dates.at(-1)}`;
    document.querySelector(".rate-status").dataset.warning = String(table.stale);
    $("status-title").textContent = `${table.stale ? "缓存 · " : ""}${dates.at(-1)?.slice(0, 10) || "暂无"} 报价`;
    const count = Object.keys(table.rates).filter((code) => code !== table.target).length;
    $("status-detail").textContent = `目标 ${table.target} · 可换算 ${count} 种外币\n报价：${range}\n获取：${new Date(table.fetchedAt).toLocaleString("zh-CN")}${table.stale ? `\n${table.warning}` : ""}`;
  } catch (error) {
    document.querySelector(".rate-status").dataset.warning = "true";
    $("status-title").textContent = "汇率暂不可用";
    $("status-detail").textContent = `${error.message}\n原价保持不变；没有可靠汇率时不做换算。`;
  }
}

$("settings-form").addEventListener("input", () => { dirty = true; notice("有未保存的设置"); controls(); });
$("provider").addEventListener("change", () => {
  providerUI();
  if ($("provider").value === "ecb" && !C.ECB_CURRENCIES.includes($("target").value)) {
    $("target").value = "CNY";
    notice("ECB 不支持原目标币种，已选人民币；保存后生效。");
  }
});
$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !state) return;
  busy = true;
  controls();
  try {
    if ($("jev-enabled").checked && ($("clear-jev").checked || (!$("jev-key").value.trim() && !state.hasJevKey))) throw new Error("请先填写 Jev Key，或关闭 AI 后再清除 Key。");
    const origins = [];
    if ($("jev-enabled").checked) origins.push("https://api.typesafe.ai/*");
    if ($("provider").value === "wise") origins.push("https://api.wise.com/*");
    if (origins.length && !await chrome.permissions.request({ origins })) throw new Error("未获得所选服务授权，设置未保存。");
    const excluded = new Set(state.settings.excludedHosts);
    if (hostname) {
      if ($("pause-site").checked) excluded.add(hostname);
      else excluded.delete(hostname);
    }
    state = await request({
      type: "saveSettings",
      settings: { enabled: $("enabled").checked, target: $("target").value, provider: $("provider").value, sourceHint: $("source-hint").value, excludedHosts: [...excluded], jevEnabled: $("jev-enabled").checked },
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
    notice("已保存，打开的网页会自动更新。");
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
  for (const [code, name] of Object.entries(C.CURRENCIES)) {
    $("target").add(new Option(`${code} · ${name}`, code));
    $("source-hint").add(new Option(`${code} · ${name}`, code));
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
    $("pause-site").disabled = !hostname;
    $("pause-site").checked = state.settings.excludedHosts.includes(hostname);
    $("site-name").textContent = hostname || "浏览器内置页不可换算";
    providerUI();
    aiUI();
    await showRates();
  } catch (error) {
    notice(error.message, true);
    $("status-title").textContent = "插件连接失败";
  } finally { busy = false; controls(); }
})();
