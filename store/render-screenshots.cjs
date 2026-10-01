// Chrome Web Store screenshots and promo tiles.
// Real extension UI and scripts (popup.html/js/css, shared.js, content.js/css) with mock Chrome APIs and fixed,
// disclosed demo rates. Nothing is fetched: fonts, rates and pages are all local.
// Needs full Chromium (see tests/browser.cjs). Usage: node store/render-screenshots.cjs → store/{en,zh_CN}/*.png
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const ext = path.join(root, 'extension');
const { i18nScript } = require(path.join(root, 'tests/i18n.cjs'));
const { fullBrowser } = require(path.join(root, 'tests/browser.cjs'));
const out = __dirname;
const version = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8')).version;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelens-shots-'));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (f) => pathToFileURL(f).href;
const extUrl = (f) => url(path.join(ext, f));

// ---------- copy per language ----------
const LANGS = {
  en: {
    pack: 'en', htmlLang: 'en', target: 'USD', host: 'maison-riviere.example',
    rates: { EUR: 0.9112, GBP: 0.7571, JPY: 148.37, CNY: 7.2004, CHF: 0.8423 },
    shop: { name: 'Maison Rivière', nav: 'Linen · Ceramics · Sale', cart: 'Panier', product: 'Stoneware pour-over set', desc: 'Hand-thrown stoneware. Free returns within 30 days.', items: [['Linen napkins ×4', '€38,00'], ['Olive-wood board', '€54,90'], ['Espresso cups', '€29,00'], ['Table runner', '€45,00']], price: '€89,00', was: '€119,00', now: '€89,00', currency: 'EUR' },
    disclosure: 'Demo store · fixed sample rates',
    shots: [
      ['01-prices', 'Shop abroad.\nRead local prices.', ['Original prices stay untouched', 'Small tags adapt to light and dark pages', 'Free daily central-bank rates, no account']],
      ['02-ticket', 'Daily rates.\nInstant calculations.', ['Quick convert from the toolbar', 'Add your card\u2019s foreign-transaction fee', 'Pause any site with one switch']],
      ['03-details', 'See how every\nnumber was made.', ['Rate, date and source for each tag', 'List price vs. current price, computed locally', 'Full keyboard support']],
      ['04-rightclick', 'Missed one?\nSelect it and right-click.', ['\u201cConvert with PriceLens\u201d on any selection', 'Parsed on your device, never uploaded', 'Ambiguous symbols are skipped, not guessed']],
      ['05-settings', 'Quiet by default.\nThere when you need it.', ['Choose a source currency for each site', 'ECB rates, or Wise with your own token', 'Optional AI help is off by default']],
    ],
    selection: 'Only €54,90 today',
    promo: ['PriceLens', 'Prices in your currency, right beside the original.'],
  },
  zh: {
    pack: 'zh_CN', htmlLang: 'zh-CN', target: 'CNY', host: 'trailhead.example',
    rates: { USD: 0.1389, EUR: 0.1265, GBP: 0.1052, JPY: 20.61, HKD: 1.0821 },
    shop: { name: 'Trailhead Outdoor', nav: 'Tents · Packs · Sale', cart: 'Cart', product: 'Trailhead 40L Backpack', desc: 'Made for weekends outdoors. Free returns within 30 days.', items: [['Merino socks', 'US$19.99'], ['Headlamp 400', 'US$34.90'], ['Trail bottle', 'US$24.00'], ['Rain shell', 'US$89.00']], price: 'US$129.99', was: 'US$159.00', now: 'US$129.00', currency: 'USD' },
    disclosure: '演示店铺 · 固定示例汇率',
    shots: [
      ['01-prices', '原价不动，\n旁边就是你的货币。', ['保留网页原价，只在旁边加一个小价签', '自动适配浅色与深色网页', '免费的央行日更汇率，无需注册']],
      ['02-ticket', '一张汇率票，\n输入金额就换算。', ['工具栏里随手换算任意金额', '可加上银行卡外币手续费', '一个开关暂停当前网站']],
      ['03-details', '每个数字，\n都有出处。', ['逐个价签显示汇率、日期与来源', '参考标价差在本地计算', '完整支持键盘操作']],
      ['04-rightclick', '漏掉的价格？\n选中后右键换算。', ['选中文字即可「用价译换算」', '只在本机解析，不上传', '有歧义的符号会跳过，不乱猜']],
      ['05-settings', '平时安静，\n需要时都在。', ['按网站指定「$」代表的货币', '央行汇率，或用自己的 Wise Token', '可选 AI 辅助，默认关闭']],
    ],
    selection: 'Only US$24.00 today',
    promo: ['价译 · PriceLens', '原价不动，旁边就是你的货币。'],
  },
};

// ---------- pages built from the real extension files ----------
function table(L) {
  const rates = Object.fromEntries(Object.entries(L.rates).map(([c, r]) => [c, { rate: r, asOf: '2026-09-29', source: 'ecb' }]));
  return { provider: 'ecb', target: L.target, rates, fetchedAt: Date.parse('2026-09-30T02:00:00Z'), stale: false };
}

function popupPage(name, L, { settings = {}, dark = false, action = '' } = {}) {
  const mock = `<script>(() => {
    let saved = null;
    const state = () => ({ ok: true, settings: { ...saved }, hasToken: false, hasJevKey: false, jevStatus: { state: 'idle', message: window.PL_I18N.getMessage('jevIdle') } });
    globalThis.chrome = { get i18n() { return window.PL_I18N; },
      permissions: { request: async () => true },
      tabs: { query: async () => [{ id: 1, url: 'https://${L.host}/p/1' }], sendMessage: async () => {} },
      runtime: { getManifest: () => ({ version: '${version}' }), sendMessage: async (m) => {
        saved ||= { ...PriceLens.DEFAULTS, target: '${L.target}', ...${JSON.stringify(settings)} };
        if (m.type === 'getState') return state();
        if (m.type === 'saveSettings') { saved = { ...m.settings }; return state(); }
        if (m.type === 'getRates') return { ok: true, table: ${JSON.stringify(table(L))} };
        throw new Error('unexpected ' + m.type);
      } } };
    addEventListener('load', () => setTimeout(async () => { ${action}; document.activeElement?.blur?.(); document.documentElement.dataset.ready = '1'; }, 400));
  })();</script>`;
  let html = fs.readFileSync(path.join(ext, 'popup.html'), 'utf8');
  html = html.replace('<head>', `<head><base href="${url(ext + path.sep)}">${mock}${i18nScript(L.pack)}${dark ? '<meta name="color-scheme" content="dark">' : ''}`);
  const file = path.join(work, `${L.pack}-${name}-popup.html`);
  fs.writeFileSync(file, html);
  return url(file);
}

const shopCSS = `
*{box-sizing:border-box}body{margin:0;font:15px/1.55 "Segoe UI",-apple-system,Roboto,Arial,sans-serif;background:#fff;color:#1d2126}
body.dark{background:#141619;color:#e9eaec}
.bar{display:flex;gap:22px;align-items:baseline;padding:16px 26px;border-bottom:1px solid #0001}
.dark .bar{border-color:#fff1}
.bar strong{font-size:17px;letter-spacing:.2px}.bar nav{opacity:.65}.bar .cart{margin-left:auto;opacity:.85}
.hero{display:grid;grid-template-columns:180px 1fr;gap:26px;padding:24px 26px 8px}
.art{height:212px;border-radius:14px;position:relative;overflow:hidden;background:linear-gradient(150deg,#e9dcc7,#c9b391)}
.art::before{content:"";position:absolute;left:38px;top:78px;width:94px;height:84px;border-radius:4px 4px 32px 32px;background:linear-gradient(105deg,#faf5ec,#d6c5a9);box-shadow:0 12px 20px #725f4830}
.art::after{content:"";position:absolute;left:64px;top:42px;width:74px;height:35px;border-radius:4px 4px 22px 22px;transform:rotate(-10deg);background:linear-gradient(105deg,#f5ece0,#d6c5a9)}
.zh .art{background:linear-gradient(150deg,#9fb0c0,#4f6272)}
.zh .art::before{left:38px;top:32px;width:106px;height:150px;border-radius:30px 30px 18px 18px;background:linear-gradient(#e0763a,#b64d1e)}
.zh .art::after{left:54px;top:92px;width:74px;height:44px;border-radius:10px;background:#8c3a15;transform:none}
h1{margin:4px 0 6px;font-size:23px;font-weight:650}
.price{font-size:30px;font-weight:700;margin:2px 0 6px}
.was{margin:0 0 10px;color:#6b7280}.dark .was{color:#9aa0a6}.was s{margin-right:8px}.was b{color:#b42318}.dark .was b{color:#ff8a70}
.desc{max-width:470px;margin:0;color:#4b5563}.dark .desc{color:#b8bcc2}
.grid{list-style:none;margin:18px 0 0;padding:0 26px 26px;display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.grid li{border:1px solid #0000001a;border-radius:12px;padding:10px 12px}.dark .grid li{border-color:#ffffff1f}
.grid .t{height:24px;border-radius:8px;margin-bottom:8px;background:#f1ece4}.dark .grid .t{background:#23262a}
.grid li:nth-child(2) .t{background:#e4ebe6}.grid li:nth-child(3) .t{background:#e7e3ef}.grid li:nth-child(4) .t{background:#efe4e4}
.dark .grid li .t{background:#23262a}
.grid span{display:block;font-size:13px;opacity:.75}.grid b{font-size:16px}
::selection{background:#b4d5fe}`;

function shopPage(name, L, { dark = false, feePercent = 0, action = '' } = {}) {
  const s = L.shop;
  const settings = { ...{ enabled: true, target: L.target, provider: 'ecb', sourceHint: '', excludedHosts: [], siteHints: {}, feePercent, savingsEnabled: true, jevEnabled: false } };
  const js = `
    const table = ${JSON.stringify(table(L))};
    const settings = ${JSON.stringify(settings)};
    window.__listeners = [];
    globalThis.chrome = { i18n: window.PL_I18N, runtime: { sendMessage: async (m) => m.type === 'getState' ? { ok: true, settings } : m.type === 'getRates' ? { ok: true, table } : { ok: false }, onMessage: { addListener: (fn) => window.__listeners.push(fn) } }, storage: { onChanged: { addListener() {} } } };
    addEventListener('load', () => setTimeout(async () => { ${action}; document.documentElement.dataset.ready = '1'; }, 900));`;
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: s.product, offers: { '@type': 'Offer', price: '0', priceCurrency: s.currency } };
  const html = `<!doctype html><html lang="${L.htmlLang === 'en' ? 'fr' : 'en'}"><head><meta charset="utf-8">${i18nScript(L.pack)}
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<link rel="stylesheet" href="${extUrl('content.css')}"><style>${shopCSS}</style></head>
<body class="${dark ? 'dark' : ''} ${L === LANGS.zh ? 'zh' : ''}">
<header class="bar"><strong>${s.name}</strong><nav>${s.nav}</nav><span class="cart">${s.cart} (0)</span></header>
<section class="hero"><div class="art"></div><div>
<h1>${s.product}</h1><p class="price">${s.price}</p>
<p class="was"><s>${s.was}</s></p>
<p class="desc">${s.desc}</p></div></section>
<ul class="grid">${s.items.map(([n, p]) => `<li><div class="t"></div><span>${n}</span><b>${p}</b></li>`).join('')}</ul>
<script src="${extUrl('shared.js')}"></script><script>${js}</script><script src="${extUrl('dom.js')}"></script><script src="${extUrl('evidence.js')}"></script><script src="${extUrl('placement.js')}"></script><script src="${extUrl('content.js')}"></script>
</body></html>`;
  const file = path.join(work, `${L.pack}-${name}-shop.html`);
  fs.writeFileSync(file, html);
  return url(file);
}

// ---------- 1280×800 composition ----------
const fontFace = `@font-face{font-family:"Space Grotesk";src:url("${extUrl('fonts/SpaceGrotesk.woff2')}") format("woff2");font-weight:300 700}`;
function composition(name, L, [, title, bullets], { shop, popup, dark = false, popupHeight = 470 }) {
  const ink = dark ? '#0d1a14' : '#f3efe5', text = dark ? '#e7f3ea' : '#123c2b', muted = dark ? '#a9c4b3' : '#4d6457', accent = dark ? '#8fe0b0' : '#1c6b47';
  const html = `<!doctype html><html lang="${L.htmlLang}"><meta charset="utf-8"><style>${fontFace}
*{box-sizing:border-box}html,body{margin:0;width:1280px;height:800px;overflow:hidden}
body{background:${ink};color:${text};font-family:"Segoe UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif;position:relative}
body::before{content:"";position:absolute;right:-180px;top:-220px;width:760px;height:760px;border-radius:50%;background:${dark ? '#12261c' : '#e7dfcd'}}
.copy{position:absolute;left:72px;top:0;bottom:0;width:430px;display:flex;flex-direction:column;justify-content:center}
.brand{display:flex;align-items:center;gap:12px;font:600 20px/1 "Space Grotesk","Segoe UI",sans-serif;letter-spacing:-.2px;margin-bottom:34px}
.brand img{width:40px;height:40px}.brand small{font:500 14px/1 "Microsoft YaHei",sans-serif;color:${muted};margin-left:2px}
h2{margin:0 0 26px;font:700 ${L.htmlLang === 'en' ? 46 : 44}px/1.18 "Space Grotesk","Microsoft YaHei","PingFang SC",sans-serif;letter-spacing:${L.htmlLang === 'en' ? '-1.2px' : '0'};white-space:pre-line}
ul{list-style:none;margin:0;padding:0}li{position:relative;padding-left:26px;margin:0 0 14px;font-size:18px;line-height:1.5;color:${muted}}
li::before{content:"";position:absolute;left:0;top:.45em;width:12px;height:8px;border-radius:5px 2px 2px 5px;background:${accent}}
.foot{position:absolute;left:72px;bottom:30px;font-size:12px;color:${muted};opacity:.85}
.window{position:absolute;left:540px;top:92px;width:690px;height:616px;border-radius:14px;overflow:hidden;background:${dark ? '#141619' : '#fff'};box-shadow:0 30px 70px -20px #0b221655,0 0 0 1px #0b22161a}
.chrome{height:44px;display:flex;align-items:center;gap:8px;padding:0 16px;background:${dark ? '#202326' : '#eceae4'}}
.chrome i{width:11px;height:11px;border-radius:50%;background:${dark ? '#3a3e43' : '#cfcac0'}}
.chrome .url{margin-left:14px;flex:1;height:26px;border-radius:13px;background:${dark ? '#141619' : '#fff'};font:13px/26px "Segoe UI",sans-serif;padding:0 14px;color:${dark ? '#9aa0a6' : '#5f6368'}}
.chrome .ext{width:26px;height:26px;border-radius:7px;background:${dark ? '#2d4a3a' : '#d7e8dc'};display:grid;place-items:center}
.chrome .ext img{width:18px;height:18px}
.window iframe{border:0;width:690px;height:572px;display:block}
.popup{position:absolute;right:62px;top:128px;width:360px;height:${popupHeight}px;border-radius:12px;overflow:hidden;box-shadow:0 24px 60px -12px #0b2216aa,0 0 0 1px #0b221626;background:${dark ? '#101512' : '#f3efe5'}}
.popup iframe{border:0;width:360px;height:${popupHeight}px;display:block}
</style><body>
<section class="copy"><div class="brand"><img src="${extUrl('icons/icon128.png')}" alt="">PriceLens${L.htmlLang === 'en' ? '' : '<small>价译</small>'}</div>
<h2>${title}</h2><ul>${bullets.map((b) => `<li>${b}</li>`).join('')}</ul></section>
${shop ? `<div class="window"><div class="chrome"><i></i><i></i><i></i><div class="url">${L.host}</div><div class="ext"><img src="${extUrl('icons/icon32.png')}" alt=""></div></div><iframe src="${shop}"></iframe></div>` : ''}
${popup ? `<div class="popup"${shop ? '' : ' style="right:auto;left:700px;top:60px"'}><iframe src="${popup}"></iframe></div>` : ''}
<div class="foot">${L.disclosure}</div></body></html>`;
  const file = path.join(work, `${name}.html`);
  fs.writeFileSync(file, html);
  return url(file);
}

function promo(L) {
  const html = `<!doctype html><html lang="${L.htmlLang}"><meta charset="utf-8"><style>${fontFace}
html,body{margin:0;width:440px;height:280px;overflow:hidden}body{background:#123c2b;color:#e7f3ea;font-family:"Segoe UI","Microsoft YaHei",sans-serif;position:relative}
.tag{position:absolute;left:34px;top:40px;right:34px;height:120px;border-radius:14px;background:#1b4f39;
 -webkit-mask:radial-gradient(circle 9px at 0 88px,#0000 96%,#000) 0 0/51% 100% no-repeat,radial-gradient(circle 9px at 100% 88px,#0000 96%,#000) 100% 0/51% 100% no-repeat}
.tag::after{content:"";position:absolute;left:14px;right:14px;top:87px;border-top:2px dashed #8fe0b066}
.pair{position:absolute;left:24px;top:18px;font:600 15px/1 "Space Grotesk",sans-serif;color:#a8d8bb}
.num{position:absolute;left:24px;top:40px;font:700 25px/1.3 "Space Grotesk","Microsoft YaHei",sans-serif;color:#9ff0c2;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.brand{position:absolute;left:34px;bottom:34px;display:flex;align-items:center;gap:10px;font:700 24px/1 "Space Grotesk","Microsoft YaHei",sans-serif}
.brand img{width:34px;height:34px}.sub{position:absolute;left:34px;right:30px;bottom:14px;font-size:12px;color:#a9c4b3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style><div class="tag"><div class="pair">${L === LANGS.en ? 'EUR → USD' : 'USD → CNY'}</div><div class="num">${L === LANGS.en ? 'Original price. Local value.' : '原价不动，换算随行。'}</div></div>
<div class="brand"><img src="${extUrl('icons/icon128.png')}" alt="">${L.promo[0]}</div><div class="sub">${L.promo[1]}</div>`;
  const file = path.join(work, `promo-${L.pack}.html`);
  fs.writeFileSync(file, html);
  return url(file);
}

function marquee(L, popup) {
  const html = `<!doctype html><html lang="${L.htmlLang}"><meta charset="utf-8"><style>${fontFace}
*{box-sizing:border-box}html,body{margin:0;width:1400px;height:560px;overflow:hidden}
body{background:#123c2b;color:#e7f3ea;font-family:"Space Grotesk","Microsoft YaHei",sans-serif}
body::before{content:"";position:absolute;left:865px;top:-100px;width:640px;height:760px;border-radius:50%;background:#1b4f39}
.copy{position:absolute;left:80px;top:65px;width:725px}.brand{display:flex;align-items:center;gap:15px;font-size:28px;font-weight:600}.brand img{width:52px;height:52px}
h1{font-size:64px;line-height:1.13;letter-spacing:-1.5px;margin:32px 0 22px;white-space:pre-line}p{color:#b5d5c2;font-size:22px;line-height:1.5;margin:0}
iframe{position:absolute;left:943px;top:42px;border:0;width:360px;height:476px;border-radius:12px;box-shadow:0 24px 60px #071b2466}
.foot{position:absolute;left:80px;bottom:32px;font:13px "Segoe UI","Microsoft YaHei",sans-serif;color:#b5d5c2}
</style><body><div class="copy"><div class="brand"><img src="${extUrl('icons/icon128.png')}" alt="">${L.promo[0]}</div>
<h1>${L === LANGS.en ? 'Keep the price.\nKnow the cost.' : '原价不动，\n心里有数。'}</h1><p>${L === LANGS.en ? 'Currency conversions, right where you shop.<br>Daily reference rates. No account required.' : '逛到哪，换算到哪。<br>央行日更参考汇率，无需注册。'}</p></div><iframe src="${popup}"></iframe><div class="foot">${L.disclosure}</div></body></html>`;
  const file = path.join(work, `marquee-${L.pack}.html`);
  fs.writeFileSync(file, html);
  return url(file);
}

// ---------- CDP capture ----------
async function launch() {
  const profile = path.join(work, 'profile');
  const proc = spawn(fullBrowser(), ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--allow-file-access-from-files',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; !fs.existsSync(portFile) && i < 150; i++) await delay(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const socket = new WebSocket((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  await once(socket, 'open');
  let id = 0; const pending = new Map();
  socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); const c = pending.get(m.id); if (!c) return; pending.delete(m.id); m.error ? c.reject(new Error(m.error.message)) : c.resolve(m.result); });
  const cmd = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); socket.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  async function capture(pageUrl, file, width, height, { dark = false, dialog = false, amount = false, advanced = false } = {}) {
    const { targetId } = await cmd('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cmd('Target.attachToTarget', { targetId, flatten: true });
    await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cmd('Page.enable', {}, sessionId);
    await cmd('Network.enable', {}, sessionId);
    await cmd('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] }, sessionId);
    await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }, sessionId);
    await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `window.renderErrors = []; addEventListener('error', e => renderErrors.push(e.message || 'Resource: ' + e.target?.src), true); addEventListener('unhandledrejection', e => renderErrors.push(String(e.reason)));` }, sessionId);
    await cmd('Page.navigate', { url: pageUrl }, sessionId);
    const evaluate = async (expression) => {
      const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const probe = `(() => {
      const docs = [document, ...Array.from(frames, f => f.document)];
      return { ready: document.readyState === 'complete' && docs.every(d => d.fonts.status === 'loaded') && docs.slice(1).every(d => d.documentElement.dataset.ready === '1'),
        errors: docs.flatMap(d => d.defaultView.renderErrors || []),
        frames: docs.slice(1).map(d => ({
          shop: !!d.querySelector('.hero'), badges: [...d.querySelectorAll('.pricelens-price')].map(n => n.textContent.trim()),
          dialog: d.querySelector('dialog[open]')?.innerText || '', result: d.querySelector('#calc-result')?.textContent || '',
          advanced: !!d.querySelector('#advanced-settings[open]'), dark: d.defaultView.matchMedia('(prefers-color-scheme: dark)').matches,
          overflowX: d.documentElement.scrollWidth > d.defaultView.innerWidth,
          notice: d.querySelector('#notice')?.textContent || '', locale: d.documentElement.lang,
          ai: !!d.querySelector('#jev-enabled:checked')
        })) };
    })()`;
    let evidence;
    for (let i = 0; i < 60; i++) { await delay(100); evidence = await evaluate(probe); if (evidence.ready || evidence.errors.length) break; }
    if (!evidence.ready || evidence.errors.length || evidence.frames.some(f => f.overflowX || f.notice || f.ai || (f.shop && f.badges.length < 4) || f.dark !== dark)
      || (dialog && !evidence.frames.some(f => f.dialog)) || (amount && !evidence.frames.some(f => /≈/.test(f.result)))
      || (advanced && !evidence.frames.some(f => f.advanced))) throw new Error(`${file}: ${JSON.stringify(evidence)}`);
    // Wait for production dialog/converter entry animations, not their translucent first frame.
    await evaluate(`(async () => {
      const docs = [document, ...Array.from(frames, f => f.document)];
      await Promise.all(docs.flatMap(d => d.getAnimations().map(a => a.finished)));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    const { data } = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    await cmd('Target.closeTarget', { targetId });
    return { file: path.relative(out, file).replaceAll('\\', '/'), width, height, png: checkPng(file, width, height), ...evidence };
  }
  return { capture, quit: async () => { await cmd('Browser.close').catch(() => {}); socket.close(); await delay(300); try { proc.kill(); } catch {} } };
}

const typeAmount = (v) => `const a = document.getElementById('calc-amount'); a.value = '${v}'; a.dispatchEvent(new Event('input', { bubbles: true }))`;
const openSavings = `document.querySelector('[data-pricelens-savings="true"]').click()`;
const selectAndShow = (L) => `
  const r = document.createRange(); r.selectNodeContents(document.querySelector('.grid li:nth-child(3) b').firstChild); getSelection().removeAllRanges(); getSelection().addRange(r);
  const amount = ${JSON.stringify(L.shop.items[2][1])};
  const p = PriceLens.findPrices(amount, '')[0];
  const t = ${JSON.stringify(table(L))};
  const v = PriceLens.convert(p.amount, p.currency, t);
  window.__listeners.forEach(fn => fn({ type: 'showConversion', text: p.original + ' (' + p.currency + ') ≈ ' + PriceLens.formatMoney(v, t.target) + '\\n' + PriceLens.t('disclaimer') }))`;

function checkPng(file, w, h) {
  const png = fs.readFileSync(file);
  if (png.readUInt32BE(16) !== w || png.readUInt32BE(20) !== h) throw new Error(`${file}: wrong size`);
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png[24] !== 8 || png[25] !== 2) throw new Error(`${file}: must be 24-bit RGB PNG without alpha`);
  for (let i = 8; i < png.length; i += 12 + png.readUInt32BE(i)) {
    if (png.toString('ascii', i + 4, i + 8) === 'tRNS') throw new Error(`${file}: transparent RGB PNG is not allowed`);
  }
  return 'RGB 24-bit';
}

(async () => {
  const b = await launch();
  const report = [];
  try {
    for (const [code, L] of Object.entries(LANGS)) {
      const dir = path.join(out, L.pack); fs.mkdirSync(dir, { recursive: true });
      const [s1, s2, s3, s4, s5] = L.shots;
      const plan = [
        [s1, { shop: shopPage('s1', L), popup: null }],
        [s2, { shop: shopPage('s2', L, { feePercent: 1.5 }), popup: popupPage('s2', L, { settings: { feePercent: 1.5 }, action: typeAmount(L === LANGS.en ? '89' : '129.99') }), popupHeight: 476, amount: true }],
        [s3, { shop: shopPage('s3', L, { action: openSavings }), popup: null, dialog: true }],
        [s4, { shop: shopPage('s4', L, { action: selectAndShow(L) }), popup: null, dialog: true }],
        [s5, { shop: shopPage('s5', L, { dark: true }), popup: popupPage('s5', L, { settings: { siteHints: { [L.host]: L.shop.currency } }, action: `document.getElementById('advanced-settings').open = true; document.getElementById('advanced-settings').scrollIntoView()` }), dark: true, popupHeight: 600, advanced: true }],
      ];
      for (const [shot, opts] of plan) {
        const file = path.join(dir, `${shot[0]}.png`);
        report.push(await b.capture(composition(`${code}-${shot[0]}`, L, shot, opts), file, 1280, 800, opts));
        console.log(`${L.pack}/${shot[0]}: ${checkPng(file, 1280, 800)}`);
      }
      const pf = path.join(dir, 'promo-small-440x280.png');
      report.push(await b.capture(promo(L), pf, 440, 280));
      console.log(`${L.pack}/promo-small: ${checkPng(pf, 440, 280)}`);
      const mf = path.join(dir, 'promo-marquee-1400x560.png');
      const ticket = popupPage('marquee', L, { action: typeAmount(L === LANGS.en ? '89' : '129.99') });
      report.push(await b.capture(marquee(L, ticket), mf, 1400, 560, { amount: true }));
      console.log(`${L.pack}/promo-marquee: ${checkPng(mf, 1400, 560)}`);
    }
  } finally { await b.quit(); }
  if (report.length !== 14 || Object.values(LANGS).some(L => report.filter(r => r.file.startsWith(L.pack + '/')).length !== 7)) throw new Error('Expected 5 screenshots and 2 promotional tiles per language');
  console.log(`Validated ${report.length} assets. Source HTML: ${work}`);
})().catch((e) => { console.error(e); process.exit(1); });
