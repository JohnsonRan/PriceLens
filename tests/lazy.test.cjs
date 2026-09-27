// Off-screen deferral needs real rendering frames: --virtual-time-budget/--dump-dom never delivers
// IntersectionObserver callbacks, so this fixture runs in real time over CDP instead.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("real-time off-screen deferral: lazy-regression", { skip: browser ? false : "Set CHROME_BIN to run isolated Chromium DOM tests", timeout: 30000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pricelens-lazy-"));
  const proc = spawn(browser, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run", "--window-size=800,600", "--remote-debugging-port=0", `--user-data-dir=${profile}`, pathToFileURL(path.join(__dirname, "fixtures/lazy-regression.html")).href], { stdio: "ignore" });
  let socket;
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    for (let i = 0; !fs.existsSync(portFile) && i < 150; i++) await delay(100);
    const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
    let page;
    for (let i = 0; !page && i < 50; i++) { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page" && t.url.startsWith("file:")); if (!page) await delay(100); }
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const waiting = new Map();
    socket.onmessage = (event) => { const message = JSON.parse(event.data); waiting.get(message.id)?.(message); };
    const evaluate = (expression) => new Promise((resolve) => { const n = ++id; waiting.set(n, (m) => resolve(m.result?.result?.value)); socket.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, returnByValue: true } })); });
    let encoded;
    for (let i = 0; i < 100 && (!encoded || encoded === "pending"); i++) { encoded = await evaluate("document.getElementById('dom-results')?.textContent"); if (encoded === "pending") await delay(100); }
    const report = JSON.parse(encoded);
    assert.equal(report.completed, true, report.error);
    const failures = report.checks.filter((item) => !item.pass);
    assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));
    console.log(`Chromium real-time: ${report.checks.length} deferral checks passed.`);
  } finally {
    socket?.close();
    proc.kill();
    await delay(200);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch { /* Chromium may still hold the temporary profile. */ }
  }
});
