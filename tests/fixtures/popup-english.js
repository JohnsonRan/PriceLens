// English UI: real popup DOM/CSS with the shipped en messages and mock Chrome APIs.
const errors = [];
window.addEventListener('error', (event) => errors.push(event.message));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
let saved;
globalThis.chrome = {
  get i18n() { return window.PL_I18N; },
  permissions: { request: async () => true },
  tabs: { query: async () => [{ id: 1, url: 'https://shop.example.com/product' }], sendMessage: async () => {} },
  runtime: { getManifest: () => ({ version: '9.8.7' }), sendMessage: async (message) => {
    saved ||= { ...PriceLens.DEFAULTS };
    const state = { ok: true, settings: { ...saved }, hasToken: false, hasJevKey: false, jevStatus: { state: 'idle', message: PriceLens.t('jevIdle') } };
    if (message.type === 'getState') return state;
    if (message.type === 'saveSettings') { saved = { ...message.settings }; return state; }
    if (message.type === 'getRates') return { ok: true, table: { provider: 'ecb', target: saved.target, rates: { USD: { rate: 0.14, asOf: '2026-09-22', source: 'ecb' }, TWD: { rate: 4.7, asOf: '2026-09-22', source: 'blend' } }, fetchedAt: Date.now(), stale: false } };
    throw new Error('Unexpected mock request');
  } },
};
window.addEventListener('load', async () => {
  const el = (id) => document.getElementById(id);
  const report = { completed: false, systemDark: matchMedia('(prefers-color-scheme: dark)').matches, checks: [] };
  const check = (name, condition, detail) => report.checks.push({ name, pass: Boolean(condition), detail });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    for (const node of document.querySelectorAll('details')) node.open = true;
    const han = /[\u4e00-\u9fff]/;
    const visible = document.body.innerText.replace(/价译/g, '');
    check('no Chinese text remains in the English popup (brand mark aside)', !han.test(visible) && !han.test(document.title));
    check('version shows in the English header too', el('version').textContent === 'v9.8.7');
    check('html lang follows the UI language', document.documentElement.lang === 'en');
    check('labels come from the en locale', el('save').textContent === 'Save' && document.querySelector('[data-i18n="summaryAdvanced"]').textContent === 'Rates, recognition and AI');
    check('currency names are English', [...el('target').options].some((o) => o.textContent === 'TWD · New Taiwan Dollar'));
    check('rate status and diagnostics are English', /^Rates of 2026-09-22$/.test(el('status-title').textContent) && el('status-detail').textContent.includes('Central-bank blend: TWD'));
    check('placeholders and aria labels are translated', el('jev-key').placeholder === 'Stored only on this device, never synced' && document.querySelector('.rate-status').getAttribute('aria-label') === 'Current rate status');
    check('help and privacy links open the English docs', [...document.querySelectorAll('[data-i18n-href]')].every((a) => /PRIVACY.md$|#readme$/.test(a.href)));
    check('expanded English settings have no horizontal overflow', document.documentElement.scrollWidth <= innerWidth);
    for (const node of document.querySelectorAll('details')) node.open = false;
    check('compact English main view fits without scrolling', document.body.scrollHeight < 480, document.body.scrollHeight);
    check('no runtime errors', errors.length === 0);
    report.completed = true;
  } catch (error) { report.error = error.message; }
  report.errors = errors;
  const output = document.createElement('pre');
  output.id = 'dom-results'; output.hidden = true; output.textContent = JSON.stringify(report); document.body.appendChild(output);
});
