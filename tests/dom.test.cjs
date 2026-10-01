const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

const { shellBrowser, platformFlags } = require("./browser.cjs");
const { i18nScript } = require("./i18n.cjs");
const browser = shellBrowser();
for (const fixture of ["dom-regression", "popup-regression", "currency-evidence-regression", "currency-context-regression", "generality-regression", "local-savings-regression", "jsonld-currency-regression", "data-currency-regression", "shadow-regression", "popup-english"]) for (const systemDark of [false, true]) test(`real DOM regression: ${fixture} (${systemDark ? "dark" : "light"} system)`, { skip: browser ? false : "Set CHROME_BIN to run isolated Chromium DOM tests" }, () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pricelens-dom-"));
  try {
    let file = path.join(__dirname, `fixtures/${fixture}.html`);
    if (fixture === "currency-context-regression") {
      const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/jev-currency-context-cases.json"), "utf8"));
      const html = fs.readFileSync(file, "utf8").replace('<meta charset="utf-8">', `<meta charset="utf-8"><base href="${pathToFileURL(file).href}">`).replace("<!-- CASES -->", cases.map(c => c.html).join("\n"));
      file = path.join(profile, "currency-context.html");
      fs.writeFileSync(file, html);
    }
    if (fixture === "shadow-regression") {
      // file:// stylesheets are opaque to scripts, so hand the mocked worker the real content.css text.
      const css = fs.readFileSync(path.join(__dirname, "../extension/content.css"), "utf8");
      const html = fs.readFileSync(file, "utf8").replace('<meta charset="utf-8">', `<meta charset="utf-8"><base href="${pathToFileURL(file).href}"><script>window.CONTENT_CSS = ${JSON.stringify(css).replace(/</g, "\\u003c")};</script>`);
      file = path.join(profile, "shadow.html");
      fs.writeFileSync(file, html);
    }
    if (fixture.startsWith("popup-")) {
      file = path.join(profile, "popup.html");
      const extension = path.resolve(__dirname, "../extension");
      const html = fs.readFileSync(path.join(extension, "popup.html"), "utf8")
        .replace(/(src|href)="(popup\.css|shared\.js|popup\.js)"/g, (_, attr, name) => `${attr}="${pathToFileURL(path.join(extension, name)).href}"`)
        .replace("<head>", `<head><base href="${pathToFileURL(extension + path.sep).href}"><script src="${pathToFileURL(path.join(__dirname, `fixtures/${fixture}.js`)).href}"></script>`);
      fs.writeFileSync(file, html);
    }
    // Fixtures load from a temp copy: <base> keeps relative paths, and chrome.i18n messages are inlined.
    const localized = path.join(profile, "fixture.html");
    fs.writeFileSync(localized, fs.readFileSync(file, "utf8").replace(/<meta charset="utf-8">(<base [^>]*>)?/, (match, base) => `<meta charset="utf-8">${base || `<base href="${pathToFileURL(file).href}">`}${i18nScript(fixture.endsWith("english") ? "en" : "zh_CN")}`));
    file = localized;
    const run = spawnSync(browser, [
      "--headless=new", "--disable-gpu", ...platformFlags, "--disable-extensions", "--disable-background-networking",
      // Tall viewport: fixtures assert whole-page placement; lazy.test.cjs covers off-screen deferral itself.
      fixture === "popup-regression" ? "--window-size=360,600" : "--window-size=800,8000",
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
