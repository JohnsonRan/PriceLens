const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

function browserPath() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const installed = path.join(os.homedir(), "AppData/Local/ms-playwright");
  if (!fs.existsSync(installed)) return null;
  for (const name of fs.readdirSync(installed).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))) {
    const exe = path.join(installed, name, "chrome-headless-shell-win64/chrome-headless-shell.exe");
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}
const browser = browserPath();
for (const fixture of ["dom-regression", "popup-regression", "currency-evidence-regression", "currency-context-regression", "generality-regression"]) for (const systemDark of [false, true]) test(`real DOM regression: ${fixture} (${systemDark ? "dark" : "light"} system)`, { skip: browser ? false : "Set CHROME_BIN to run isolated Chromium DOM tests" }, () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pricelens-dom-"));
  try {
    let file = path.join(__dirname, `fixtures/${fixture}.html`);
    if (fixture === "currency-context-regression") {
      const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/jev-currency-context-cases.json"), "utf8"));
      const html = fs.readFileSync(file, "utf8").replace('<meta charset="utf-8">', `<meta charset="utf-8"><base href="${pathToFileURL(file).href}">`).replace("<!-- CASES -->", cases.map(c => c.html).join("\n"));
      file = path.join(profile, "currency-context.html");
      fs.writeFileSync(file, html);
    }
    if (fixture === "popup-regression") {
      file = path.join(profile, "popup.html");
      const extension = path.resolve(__dirname, "../extension");
      const html = fs.readFileSync(path.join(extension, "popup.html"), "utf8")
        .replace(/(src|href)="(popup\.css|shared\.js|popup\.js)"/g, (_, attr, name) => `${attr}="${pathToFileURL(path.join(extension, name)).href}"`)
        .replace("<head>", `<head><base href="${pathToFileURL(extension + path.sep).href}"><script src="${pathToFileURL(path.join(__dirname, "fixtures/popup-regression.js")).href}"></script>`);
      fs.writeFileSync(file, html);
    }
    const run = spawnSync(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--disable-background-networking", ...(fixture === "popup-regression" ? ["--window-size=360,600"] : []),
      `--blink-settings=preferredColorScheme=${systemDark ? 0 : 1}`,
      "--disable-component-update", "--disable-sync", "--no-first-run", "--no-default-browser-check",
      `--user-data-dir=${profile}`, "--virtual-time-budget=10000", "--dump-dom",
      pathToFileURL(file).href,
    ], { encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(run.status, 0, `Isolated Chromium failed: ${run.error?.message || ""}\n${run.stderr?.slice(-1800) || "No stderr"}`);
    const encoded = run.stdout.match(/<pre id="dom-results"[^>]*>([\s\S]*?)<\/pre>/)?.[1];
    assert.ok(encoded && encoded !== "pending", "DOM checks did not finish");
    const report = JSON.parse(encoded.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
    assert.equal(report.completed, true, report.error);
    assert.equal(report.systemDark, systemDark, "verify the browser's actual system-color preference");
    const failures = report.checks.filter((item) => !item.pass);
    assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));
    console.log(`Chromium DOM: ${report.checks.length} checks passed (system ${systemDark ? "dark" : "light"}, mock rates, ${fixture === "currency-context-regression" ? "mock Jev" : fixture === "popup-regression" ? "mock Chrome APIs" : "AI off"}, no live account).`);
  } finally {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch { /* The owned temporary profile may still be held by Chromium during shutdown. */ }
  }
});
