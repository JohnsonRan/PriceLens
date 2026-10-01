// Injected before the actual popup scripts: real DOM/CSS, isolated mock Chrome APIs, no live credentials/network.
const tabMessages = [];
let saved, granted = true, hasToken = false;
// pageStatus replies: the page is still scanning at first, then settles; later tests change the settled reply.
const settledStatus = { ok: true, active: true, skipped: 5, symbols: ['$', '¥'], pending: false };
const statusReplies = [{ ...settledStatus, skipped: 0, pending: true }];
// Retries after the first pending reply wait here, so the scanning-state check cannot race a slow `load` event.
let settleScan; const scanGate = new Promise((resolve) => { settleScan = resolve; });
const messages = [], permissions = [], errors = [];
window.addEventListener('error', (event) => errors.push(event.message));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
const response = () => ({ ok: true, settings: { ...saved }, hasToken, hasJevKey: true, jevStatus: { state: 'idle', message: '尚未调用模型' } });
globalThis.chrome = { get i18n() { return window.PL_I18N; }, // injected after this script in the popup head
  permissions: { request: async (options) => { permissions.push(options); return granted; } },
  tabs: { query: async () => [{ id: 1, url: 'https://shop.example.com/product' }], sendMessage: async (id, message, options) => { tabMessages.push([message, options]); if (message.type !== 'pageStatus') return; if (tabMessages.filter(([m]) => m.type === 'pageStatus').length > 1) await scanGate; return statusReplies.shift() ?? { ...settledStatus }; } },
  runtime: { getManifest: () => ({ version: '9.8.7' }), sendMessage: async (message) => {
    messages.push(message);
    saved ||= { ...PriceLens.DEFAULTS, jevEnabled: true };
    if (message.type === 'getState') return response();
    if (message.type === 'saveSettings') { saved = { ...message.settings }; if (message.token !== null) hasToken = Boolean(message.token); return response(); }
    if (message.type === 'getRates') return { ok: true, table: { provider: saved.provider, target: saved.target, rates: { USD: { rate: 0.14, asOf: '2026-09-22' }, EUR: { rate: 0.5, asOf: '2026-09-22' } }, fetchedAt: Date.now(), stale: false } };
    throw new Error('Unexpected mock request');
  } },
};
window.addEventListener('load', async () => {
  const el = (id) => document.getElementById(id);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 40));
  // Poll instead of sleeping for the popup's own timers; the cap keeps a failure inside the virtual-time budget.
  const until = async (cond, ms) => { for (let t = 0; t < ms && !cond(); t += 20) await new Promise((resolve) => setTimeout(resolve, 20)); };
  const statusAsks = () => tabMessages.filter(([m]) => m.type === 'pageStatus').length;
  const report = { completed: false, systemDark: matchMedia('(prefers-color-scheme: dark)').matches, checks: [] };
  const check = (name, condition, detail) => report.checks.push({ name, pass: Boolean(condition), detail });
  try {
    await wait();
    const view = new URL(location.href).searchParams.get('view');
    if (view) {
      settleScan();
      if (view === 'ai') { el('advanced-settings').open = true; el('ai-settings').open = true; await wait(); el('ai-settings').scrollIntoView({ block: 'start' }); }
      return; // Screenshot mode does not exercise or mutate saved mock settings.
    }
    const logo = document.querySelector('header .logo');
    check('header shows the manifest version, readable and on one line', el('version').textContent === 'v9.8.7' && el('version').checkVisibility() && parseFloat(getComputedStyle(el('version')).fontSize) >= 12 && el('version').getClientRects().length === 1 && el('version').getBoundingClientRect().right <= innerWidth);
    check('header displays the generated brand icon', logo?.tagName === 'IMG' && logo.complete && logo.naturalWidth === 128 && logo.naturalHeight === 128);
    check('brand icon has no opaque white tile in either theme', getComputedStyle(logo).backgroundColor === 'rgba(0, 0, 0, 0)');
    check('help and privacy links open the Chinese docs', [...document.querySelectorAll('[data-i18n-href]')].every((a) => /.zh-CN.md$/.test(a.href)));
    check('all secondary panels stay collapsed even with AI already enabled', [...document.querySelectorAll('details')].every((node) => !node.open));
    check('daily controls remain visible, AI/credentials/diagnostics do not', ['target', 'enabled', 'pause-site', 'status-title'].every((id) => el(id).checkVisibility()) && ['provider', 'jev-enabled', 'jev-key', 'jev-status', 'status-detail'].every((id) => !el(id).checkVisibility()));
    check('settings stay usable while the page is still scanning', el('skip-notice').hidden && !el('refresh').disabled);
    settleScan();
    await until(() => !el('skip-notice').hidden, 1000); await wait();
    check('a page that reports a pending scan is asked again until it settles', statusAsks() === 2, tabMessages.length);
    // Chrome caps popups at 600px; 480 keeps the main view (incl. the quick-convert row) well inside it.
    {
      const withNotice = document.body.scrollHeight;
      el('skip-notice').hidden = true;
      const base = document.body.scrollHeight;
      el('skip-notice').hidden = false;
      check('compact main view fits without scrolling', base < 480 && document.documentElement.scrollWidth <= innerWidth, base);
      check('with the skipped-price notice it still fits Chrome\'s 600px popup cap', withNotice < 560, withNotice);
    }
    check('save is disabled before edits; refresh is available', el('save').disabled && !el('refresh').disabled);
    check('skipped ambiguous prices on this page are reported from the top frame only', el('skip-notice').checkVisibility() && el('skip-text').textContent === '此页有 5 个价格只写了 $ ¥，无法确定币种，已跳过。' && tabMessages.some(([m, o]) => m.type === 'pageStatus' && o?.frameId === 0), el('skip-text').textContent);
    check('only the count is a live region, not the notice with its button', el('skip-text').getAttribute('role') === 'status' && !el('skip-notice').hasAttribute('role'));
    el('skip-action').click(); await wait();
    check('the notice action opens this site\'s currency setting without dirtying the form', el('advanced-settings').open && document.activeElement === el('site-hint') && el('save').disabled);
    el('advanced-settings').open = false; await wait();
    check('important secondary text stays at least 12px', ['token-state', 'jev-state', 'clear-token-row', 'clear-jev-row', 'source-badge', 'status-detail'].every(id => parseFloat(getComputedStyle(el(id)).fontSize) >= 12));
    check('advanced entry names its contents', el('advanced-settings').querySelector('summary').textContent === '汇率、识别与 AI');
    el('advanced-settings').open = true;
    el('ai-settings').open = true;
    check('AI consent has visible prior recipient/data/cost disclosures', ['jev-enabled'].every((id) => { const input = el(id), hint = el(input.getAttribute('aria-describedby')); return hint?.checkVisibility() && Boolean(hint.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING); }) && /TypeSafe/.test(el('ai-consent').textContent) && el('ai-consent').textContent.includes('可能收费') && el('ai-consent').textContent.includes('360 字符'));
    check('diagnostic detail still requires its own disclosure', !el('jev-status').checkVisibility() && !el('status-detail').checkVisibility());
    check('stored credentials never prefill the key field', el('jev-key').value === '' && el('jev-key').type === 'password');
    check('store release has no AI reference-difference entry', !el('jev-savings-enabled') && !el('savings-status'));
    check('local reference difference is on by default and explained', el('savings-enabled').checked && el('savings-enabled').checkVisibility() && /本地计算/.test(el('savings-hint').textContent));
    el('jev-enabled').click();
    check('unsaved opt-out is not persisted', saved.jevEnabled && !el('save').disabled && el('refresh').disabled);
    check('unsaved preferences use pending rather than success feedback', el('notice').dataset.tone === 'pending');
    el('save').click(); await wait();
    check('AI opt-out saves without requesting permission', !saved.jevEnabled && permissions.length === 0 && el('notice').textContent.includes('已保存') && el('save').disabled);
    check('after a save the page status is read again', el('skip-notice').checkVisibility(), tabMessages.filter(([m]) => m.type === 'pageStatus').length);
    await until(() => el('notice').textContent === '', 3500);
    check('the saved confirmation fades and the save bar hides', el('notice').textContent === '' && getComputedStyle(document.querySelector('.save-area')).display === 'none');
    {
      // A page still busy after every retry: its skipped count is about to change, so none is shown.
      statusReplies.push(...Array.from({ length: 10 }, () => ({ ...settledStatus, pending: true })));
      const asked = statusAsks();
      el('fee').value = '0.5'; el('fee').dispatchEvent(new Event('input', { bubbles: true }));
      el('save').click(); await until(() => statusAsks() - asked >= 10, 3000); await new Promise((resolve) => setTimeout(resolve, 300)); // an 11th ask would land here
      const retries = statusAsks() - asked;
      check('a page still scanning after every retry shows no skipped count', retries === 10 && el('skip-notice').hidden, retries);
      el('fee').value = '0'; el('fee').dispatchEvent(new Event('input', { bubbles: true }));
      el('save').click(); await wait();
    }
    el('enabled').click(); await wait();
    check('a changed setting shows the unsaved bar', !el('save').disabled && el('notice').textContent.includes('未保存') && getComputedStyle(document.querySelector('.save-area')).display !== 'none');
    el('enabled').click(); await wait();
    check('changing it back clears the unsaved state and hides the bar', el('save').disabled && el('notice').textContent === '' && getComputedStyle(document.querySelector('.save-area')).display === 'none');
    el('jev-enabled').click(); el('save').click(); await wait();
    check('AI opt-in asks only its optional service permission', saved.jevEnabled && permissions.length === 1 && JSON.stringify(permissions[0].origins) === JSON.stringify(['https://api.typesafe.ai/*']));
    el('jev-enabled').click(); el('save').click(); await wait();
    check('saving opt-out stops AI', !saved.jevEnabled);
    granted = false;
    const saves = messages.filter((m) => m.type === 'saveSettings').length;
    el('jev-enabled').click();
    el('save').click(); await wait();
    check('permission denial cannot save consent and leaves explicit feedback', messages.filter((m) => m.type === 'saveSettings').length === saves && !saved.jevEnabled && el('notice').dataset.error === 'true' && el('notice').textContent.includes('未保存'));
    // Revert the unsaved attempted opt-in; ordinary preferences do not need AI permission.
    el('jev-enabled').click();
    el('target').value = 'USD'; el('target').dispatchEvent(new Event('input', { bubbles: true }));
    el('pause-site').click();
    el('save').click(); await wait();
    check('target and current-site pause save independently of AI', saved.target === 'USD' && saved.excludedHosts.includes('shop.example.com'));
    el('provider').value = 'wise'; el('provider').dispatchEvent(new Event('change'));
    el('token').value = 'mock-wise-token'; el('token').dispatchEvent(new Event('input', { bubbles: true }));
    const beforeWise = messages.filter((m) => m.type === 'saveSettings').length;
    el('save').click(); await wait();
    check('Wise denial cannot persist provider or token', messages.filter((m) => m.type === 'saveSettings').length === beforeWise && saved.provider === 'ecb' && JSON.stringify(permissions.at(-1).origins) === JSON.stringify(['https://api.wise.com/*']));
    granted = true; el('jev-enabled').click(); el('save').click(); await wait();
    check('Wise and AI request combined origins in a single permission prompt', saved.provider === 'wise' && saved.jevEnabled && JSON.stringify(permissions.at(-1).origins) === JSON.stringify(['https://api.typesafe.ai/*', 'https://api.wise.com/*']));
    el('savings-enabled').click(); el('save').click(); await wait();
    check('local reference difference saves independently of AI', saved.savingsEnabled === false && saved.jevEnabled && saved.provider === 'wise');
    el('savings-enabled').click(); el('save').click(); await wait();
    check('local reference difference can be re-enabled', saved.savingsEnabled === true);
    const promptsBefore = permissions.length, savesBefore = messages.filter((m) => m.type === 'saveSettings').length;
    el('clear-token').click(); el('save').click(); await wait();
    check('Wise without a token fails before any permission prompt', permissions.length === promptsBefore && messages.filter((m) => m.type === 'saveSettings').length === savesBefore && el('notice').dataset.error === 'true');
    el('clear-token').click(); // Undo the previous check's token clearing.
    el('site-hint').value = 'CAD'; el('site-hint').dispatchEvent(new Event('input', { bubbles: true }));
    el('fee').value = '1.5'; el('fee').dispatchEvent(new Event('input', { bubbles: true }));
    el('save').click(); await wait();
    check('per-site currency and card fee save for the current host', saved.siteHints['shop.example.com'] === 'CAD' && saved.feePercent === 1.5 && el('recognition-hint').textContent.includes('CAD') && el('footer-estimate').textContent.includes('1.5%'), [saved.siteHints, saved.feePercent, el('notice').textContent]);
    el('calc-from').value = 'EUR'; el('calc-from').dispatchEvent(new Event('input', { bubbles: true }));
    el('calc-amount').value = '10'; el('calc-amount').dispatchEvent(new Event('input', { bubbles: true }));
    check('quick converter applies the loaded rate and fee without dirtying settings', el('calc-result').textContent.includes('20.30') && el('calc-result').textContent.includes('1.5%') && el('save').disabled && !el('notice').textContent.includes('未保存'), el('calc-result').textContent);
    el('calc-amount').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    el('calc-from').value = 'GBP'; el('calc-from').dispatchEvent(new Event('input', { bubbles: true }));
    check('quick converter names a missing rate instead of guessing', el('calc-result').textContent.includes('GBP'));
    el('calc-amount').value = '-5'; el('calc-amount').dispatchEvent(new Event('input', { bubbles: true }));
    el('site-hint').value = ''; el('site-hint').dispatchEvent(new Event('input', { bubbles: true }));
    el('save').click(); await wait();
    check('an invalid quick-convert amount never blocks saving settings', el('settings-form').checkValidity() && el('calc-result').textContent === '');
    check('clearing the site currency removes only this host', !('shop.example.com' in saved.siteHints));
    check('expanded settings have no horizontal overflow', document.documentElement.scrollWidth <= innerWidth);
    check('no runtime errors', errors.length === 0);
    report.completed = true;
  } catch (error) { report.error = error.message; }
  report.errors = errors;
  const output = document.createElement('pre');
  output.id = 'dom-results'; output.hidden = true; output.textContent = JSON.stringify(report); document.body.appendChild(output);
});
