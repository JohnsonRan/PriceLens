const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const C = require("../extension/shared.js");

async function popup(settings = {}, jevStatus = { state: "idle", message: "尚未调用模型" }, granted = true, failState = false) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", checked: false, textContent: "", dataset: {}, options: [], listeners: {},
      add(option) { this.options.push(option); },
      addEventListener(type, listener) { this.listeners[type] = listener; },
    });
    return elements.get(id);
  };
  let saved = { ...C.DEFAULTS, ...settings };
  const response = () => ({ ok: true, settings: { ...saved }, hasToken: false, hasJevKey: true, jevStatus });
  const context = vm.createContext({
    PriceLens: C, console, URL, Date,
    Option: class { constructor(text, value) { Object.assign(this, { text, value }); } },
    document: { getElementById: element, querySelector: element },
    chrome: {
      permissions: { request: async () => granted },
      tabs: { query: async () => [{ id: 1, url: "https://shop.test/" }], sendMessage: async () => {} },
      runtime: { sendMessage: async (message) => {
        if (message.type === "getState") { if (failState) throw new Error("模拟后台不可用"); return response(); }
        if (message.type === "saveSettings") { saved = message.settings; return response(); }
        if (message.type === "getRates") return { ok: true, table: { target: saved.target, provider: "ecb", rates: { USD: { rate: 0.14, asOf: "2026-09-21" } }, fetchedAt: Date.now() } };
        throw new Error(`Unexpected popup request: ${message.type}`);
      } },
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve("../extension/popup.js"), "utf8"), context);
  await new Promise(setImmediate);
  return element;
}

test("automatic currency label explains local vs Jev recognition, without claiming success", async () => {
  const html = fs.readFileSync(require.resolve("../extension/popup.html"), "utf8");
  assert.match(html, /<option value="">自动识别币种<\/option>/);
  assert.ok(!html.includes("自动判断 · 不确定就跳过"));
  const local = await popup();
  assert.match(local("recognition-hint").textContent, /使用页面币种信息；不确定时跳过/);
  assert.ok(!local("recognition-hint").textContent.includes("Jev"));
  const ai = await popup({ jevEnabled: true });
  assert.match(ai("recognition-hint").textContent, /AI 辅助疑难币种；不确定时跳过/);
  assert.notEqual(ai("ai-settings").open, true, "saved AI consent must not auto-expand settings");
  assert.equal(ai("save").disabled, true, "unchanged settings need no save");
  const failed = await popup({ jevEnabled: true }, { state: "error", message: "Jev 网络请求失败，保留本地识别。" });
  assert.match(failed("recognition-hint").textContent, /不确定时跳过/);
  assert.equal(failed("jev-status").dataset.error, "true");
  assert.match(failed("jev-status").textContent, /失败/);
});

test("recognition description follows saved settings, manual hints never override explicit currency", async () => {
  const el = await popup();
  el("jev-enabled").checked = true;
  el("settings-form").listeners.input();
  assert.ok(!el("recognition-hint").textContent.includes("AI"), "unsaved checkbox is not active consent");
  await el("settings-form").listeners.submit({ preventDefault() {} });
  assert.match(el("recognition-hint").textContent, /AI 辅助/);
  const manual = await popup({ sourceHint: "CAD", jevEnabled: true });
  assert.match(manual("recognition-hint").textContent, /CAD 仅补歧义符号，全局生效/);
  assert.match(manual("recognition-hint").textContent, /明确币种优先/);
});

test("pending preferences and failed initialization never signal success", async () => {
  const changed = await popup();
  changed("settings-form").listeners.input();
  assert.equal(changed("notice").dataset.tone, "pending");
  assert.match(changed("notice").textContent, /未保存/);
  const failed = await popup({}, undefined, true, true);
  assert.equal(failed(".rate-status").dataset.warning, "true");
  assert.equal(failed("status-title").textContent, "插件连接失败");
  assert.equal(failed("save").disabled, true);
  assert.equal(failed("refresh").disabled, true);
});

test("store popup omits the unaccepted reference-difference controls", () => {
  const html = fs.readFileSync(require.resolve("../extension/popup.html"), "utf8");
  const manifest = require("../extension/manifest.json");
  assert.match(html, /<img class="logo" src="icons\/icon128\.png"/);
  for (const [size, icon] of Object.entries(manifest.icons)) {
    assert.equal(icon, `icons/icon${size}.png`);
    assert.ok(fs.existsSync(require("node:path").join(__dirname, "../extension", icon)), `${icon} must be available in the public extension`);
  }
  const js = fs.readFileSync(require.resolve("../extension/popup.js"), "utf8");
  assert.doesNotMatch(html + js, /jev-savings-enabled|savings-status/);
  assert.match(html, /PRIVACY\.md/);
});

test("denied optional permission cannot save AI consent", async () => {
  const el = await popup({}, undefined, false);
  el("jev-enabled").checked = true;
  el("settings-form").listeners.input();
  await el("settings-form").listeners.submit({ preventDefault() {} });
  assert.match(el("notice").textContent, /授权.*未保存/);
  assert.equal(el("notice").dataset.error, "true");
  assert.equal(el("privacy-state").textContent, "");
  assert.equal(el("refresh").disabled, true, "unsaved changes remain dirty");
});

function tokens(css) {
  return Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map((m) => [m[1], m[2]]));
}
function contrast(a, b) {
  const luminance = (hex) => {
    const rgb = hex.match(/[\da-f]{2}/gi).map((v) => parseInt(v, 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const [x, y] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (x + 0.05) / (y + 0.05);
}

test("both popup palettes and price/cache badges meet text contrast checks", () => {
  const css = fs.readFileSync(require.resolve("../extension/popup.css"), "utf8");
  const [light, dark] = css.split("@media (prefers-color-scheme: dark)").map(tokens);
  assert.ok(dark.page, "native prefers-color-scheme dark palette exists");
  for (const [name, theme] of [["light", light], ["dark", { ...light, ...dark }]]) {
    for (const bg of ["page", "surface", "panel", "soft", "badge"]) {
      for (const fg of ["text", "muted", "subtle", "link"]) {
        const ratio = contrast(theme[fg], theme[bg]);
        assert.ok(ratio >= 4.5, `${name} ${fg}/${bg}: ${ratio.toFixed(2)}`);
      }
    }
    for (const fg of ["success", "warning", "error"]) assert.ok(contrast(theme[fg], theme.page) >= 4.5, `${name} ${fg}`);
    for (const bg of ["accent", "accent-hover"]) assert.ok(contrast(theme["on-accent"], theme[bg]) >= 4.5, `${name} button`);
    for (const bg of ["page", "surface", "panel"]) assert.ok(contrast(theme.focus, theme[bg]) >= 3, `${name} focus`);
  }
  const badgeCSS = fs.readFileSync(require.resolve("../extension/content.css"), "utf8");
  assert.ok(!badgeCSS.includes("prefers-color-scheme"), "page badges must not select their palette from the OS");
  const [badgeLight, badgeDark] = badgeCSS.split('.pricelens-price[data-pricelens][data-pricelens-theme="dark"]').map(tokens);
  assert.ok(badgeDark?.["pl-bg"], "test the actual dark badge palette, not the light fallback twice");
  for (const palette of [badgeLight, { ...badgeLight, ...badgeDark }]) {
    assert.ok(contrast(palette["pl-text"], palette["pl-bg"]) >= 4.5);
    assert.ok(contrast(palette["pl-cache-text"], palette["pl-cache-bg"]) >= 4.5);
  }
});
