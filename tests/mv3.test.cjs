// Real unpacked MV3 integration, with synthetic cached rates and network disabled.
// Uses Node's native WebSocket/CDP; no npm/browser downloads, real profile or credentials.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function browserPath() {
  if (process.env.MV3_CHROME_BIN) return process.env.MV3_CHROME_BIN;
  const root = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  if (!fs.existsSync(root)) return null;
  for (const name of fs.readdirSync(root).filter(n => /^chromium-\d+$/.test(n)).sort((a,b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))) {
    const file = path.join(root, name, 'chrome-win64/chrome.exe');
    if (fs.existsSync(file)) return file;
  }
  return null;
}
const browser = browserPath();
test('real MV3: trusted storage/messages, live content toggles and keyboard-accessible details', { skip: browser ? false : 'Set MV3_CHROME_BIN to full Chromium (not headless shell)', timeout: 45000 }, async () => {
  const extension = path.resolve(__dirname, '../extension');
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelens-mv3-'));
  const profile = path.join(evidence, 'profile');
  fs.mkdirSync(profile);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="en"><title>PriceLens MV3 smoke</title><style>body{font:18px Arial;background:white;color:#222;padding:20px}</style><h1>Local synthetic shop</h1><p>USD 10</p><p>EUR 20</p></html>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const proc = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, 'about:blank'], { stdio: 'ignore' });
  let launchError, socket, command;
  proc.on('error', error => { launchError = error; });
  const pending = new Map();
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i=0; !fs.existsSync(portFile) && i<150; i++) {
      if (launchError) throw launchError;
      if (proc.exitCode !== null) throw new Error('Chromium exited before CDP was ready');
      await delay(100);
    }
    assert.ok(fs.existsSync(portFile), 'Chromium CDP must become ready');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    socket = new WebSocket(version.webSocketDebuggerUrl);
    await once(socket, 'open');
    let nextId = 0;
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('CDP closed')); }
      pending.clear();
    });
    command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method + ' ' + (params.expression || '').slice(0, 160))); }, 12000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const attach = async targetId => (await command('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const evaluate = async (session, expression) => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, session);
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const waitFor = (session, condition) => evaluate(session, `new Promise((resolve,reject)=>{const until=Date.now()+8000;const timer=setInterval(()=>{if(${condition}){clearInterval(timer);resolve(true)}else if(Date.now()>until){clearInterval(timer);reject(new Error('Timed out: '+${JSON.stringify(condition)}))}},50)})`);
    const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
    const workerSessions = new Map();
    let worker, workerSession;
    for (let i=0; !worker && i<100; i++) {
      for (const candidate of (await command('Target.getTargets')).targetInfos.filter(t => t.type === 'service_worker' && t.url.endsWith('/background.js'))) {
        if (!workerSessions.has(candidate.targetId)) {
          const session = await attach(candidate.targetId);
          await command('Runtime.enable', {}, session);
          await command('Runtime.runIfWaitingForDebugger', {}, session);
          workerSessions.set(candidate.targetId, session);
        }
        const session = workerSessions.get(candidate.targetId);
        // Chromium itself also ships background.js workers; match our manifest, not its filename.
        const identity = await evaluate(session, `({name:chrome.runtime?.getManifest?.().name,ready:typeof PriceLens!=='undefined'&&Boolean(chrome.storage)})`);
        if (identity.name === manifest.name && identity.ready) { worker = candidate; workerSession = session; break; }
      }
      if (!worker) await delay(100);
    }
    assert.ok(worker, 'Unpacked PriceLens MV3 worker must start');
    const extensionId = new URL(worker.url).host;
    await evaluate(workerSession, `(async()=>{
      self.fetch=()=>Promise.reject(new Error('External network disabled for smoke test'));
      await chrome.storage.sync.set({enabled:true,target:'CNY',provider:'ecb',sourceHint:'',excludedHosts:[]});
      await chrome.storage.local.set({jevEnabled:false,'rates:ecb:CNY':{provider:'ecb',target:'CNY',fetchedAt:Date.now(),stale:false,rates:{USD:{rate:.125,asOf:new Date().toISOString()},EUR:{rate:.1,asOf:new Date().toISOString()}}}});
    })()`);
    const pageTarget = await command('Target.createTarget', { url: `http://127.0.0.1:${server.address().port}/` });
    const page = await attach(pageTarget.targetId);
    await command('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, page);
    await waitFor(page, `document.querySelectorAll('.pricelens-price').length===2`);
    assert.equal(await evaluate(page, `document.querySelector('.pricelens-price').textContent.includes('80.00')`), true);
    assert.equal(await evaluate(page, `document.querySelectorAll('.pricelens-price[tabindex="0"]').length`), 1);
    await command('Page.bringToFront', {}, page);
    await evaluate(page, `document.querySelector('.pricelens-price').focus()`);
    assert.equal(await evaluate(page, `document.activeElement.matches('.pricelens-price') && document.hasFocus()`), true, 'Price button must own real keyboard focus');
    for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) }, page);
    await waitFor(page, `document.querySelector('dialog[open]')`);
    assert.equal(await evaluate(page, `document.querySelector('dialog').textContent.includes('仅供参考')`), true);
    const screenshot = await command('Page.captureScreenshot', { format: 'png' }, page);
    fs.writeFileSync(path.join(evidence, 'details.png'), Buffer.from(screenshot.data, 'base64'));
    for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, page);
    await waitFor(page, `!document.querySelector('dialog')`);
    assert.equal(await evaluate(page, `document.activeElement.matches('.pricelens-price')`), true);
    const popupTarget = await command('Target.createTarget', { url: `chrome-extension://${extensionId}/popup.html` });
    const popup = await attach(popupTarget.targetId);
    await command('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: false }, popup);
    await waitFor(popup, `document.querySelector('#refresh') && !document.querySelector('#refresh').disabled`);
    assert.equal(await evaluate(popup, `document.querySelector('#status-title').textContent.includes('报价')`), true);
    await evaluate(popup, `document.querySelector('#enabled').click(); document.querySelector('#save').click()`);
    await waitFor(page, `document.querySelectorAll('.pricelens-price').length===0`);
    await waitFor(popup, `!document.querySelector('#refresh').disabled`);
    await evaluate(popup, `document.querySelector('#enabled').click(); document.querySelector('#save').click()`);
    await waitFor(page, `document.querySelectorAll('.pricelens-price').length===2`);
    await waitFor(popup, `!document.querySelector('#refresh').disabled`);
    await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, popup);
    const popupShot = await command('Page.captureScreenshot', { format: 'png' }, popup);
    fs.writeFileSync(path.join(evidence, 'popup-dark.png'), Buffer.from(popupShot.data, 'base64'));
    console.log('Real MV3 worker, popup sender/storage, content refresh, Enter/Escape and focus restoration passed. Synthetic cached rates; fetch disabled. Evidence: ' + evidence);
  } finally {
    if (command && socket?.readyState === WebSocket.OPEN) await command('Browser.close').catch(() => {});
    socket?.close();
    server.closeAllConnections(); server.close();
    if (proc.exitCode === null) {
      const closed = once(proc, 'exit').catch(() => {});
      proc.kill();
      await Promise.race([closed, delay(2000)]);
    }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { console.log('Owned test profile retained for cleanup: ' + profile); }
  }
});
