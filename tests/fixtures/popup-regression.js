// Injected before the actual popup scripts: real DOM/CSS, isolated mock Chrome APIs, no live credentials/network.
let saved, granted = true;
const messages = [], permissions = [], errors = [];
window.addEventListener('error', (event) => errors.push(event.message));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
const response = () => ({ ok: true, settings: { ...saved }, hasToken: false, hasJevKey: true, jevStatus: { state: 'idle', message: '尚未调用模型' } });
globalThis.chrome = {
  permissions: { request: async (options) => { permissions.push(options); return granted; } },
  tabs: { query: async () => [{ id: 1, url: 'https://shop.example.com/product' }], sendMessage: async () => {} },
  runtime: { sendMessage: async (message) => {
    messages.push(message);
    saved ||= { ...PriceLens.DEFAULTS, jevEnabled: true };
    if (message.type === 'getState') return response();
    if (message.type === 'saveSettings') { saved = { ...message.settings }; return response(); }
    if (message.type === 'getRates') return { ok: true, table: { provider: saved.provider, target: saved.target, rates: { USD: { rate: 0.14, asOf: '2026-09-22' } }, fetchedAt: Date.now(), stale: false } };
    throw new Error('Unexpected mock request');
  } },
};
window.addEventListener('load', async () => {
  const el = (id) => document.getElementById(id);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 40));
  const report = { completed: false, systemDark: matchMedia('(prefers-color-scheme: dark)').matches, checks: [] };
  const check = (name, condition) => report.checks.push({ name, pass: Boolean(condition) });
  try {
    await wait();
    const view = new URL(location.href).searchParams.get('view');
    if (view) {
      if (view === 'ai') { el('advanced-settings').open = true; el('ai-settings').open = true; await wait(); el('ai-settings').scrollIntoView({ block: 'start' }); }
      return; // Screenshot mode does not exercise or mutate saved mock settings.
    }
    const logo = document.querySelector('header .logo');
    check('header displays the generated brand icon', logo?.tagName === 'IMG' && logo.complete && logo.naturalWidth === 128 && logo.naturalHeight === 128);
    check('brand icon has no opaque white tile in either theme', getComputedStyle(logo).backgroundColor === 'rgba(0, 0, 0, 0)');
    check('all secondary panels stay collapsed even with AI already enabled', [...document.querySelectorAll('details')].every((node) => !node.open));
    check('daily controls remain visible, AI/credentials/diagnostics do not', ['target', 'enabled', 'pause-site', 'status-title'].every((id) => el(id).checkVisibility()) && ['provider', 'jev-enabled', 'jev-key', 'jev-status', 'status-detail'].every((id) => !el(id).checkVisibility()));
    check('compact main view fits without scrolling', document.body.scrollHeight < 450 && document.documentElement.scrollWidth <= innerWidth);
    check('save is disabled before edits; refresh is available', el('save').disabled && !el('refresh').disabled);
    check('important secondary text stays at least 12px', ['token-state', 'jev-state', 'clear-token-row', 'clear-jev-row', 'source-badge', 'status-detail'].every(id => parseFloat(getComputedStyle(el(id)).fontSize) >= 12));
    check('advanced entry names its contents', el('advanced-settings').querySelector('summary').textContent === '汇率、识别与 AI');
    el('advanced-settings').open = true;
    el('ai-settings').open = true;
    check('AI consent has visible prior recipient/data/cost disclosures', ['jev-enabled'].every((id) => { const input = el(id), hint = el(input.getAttribute('aria-describedby')); return hint?.checkVisibility() && Boolean(hint.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING); }) && /TypeSafe/.test(el('ai-consent').textContent) && el('ai-consent').textContent.includes('可能收费') && el('ai-consent').textContent.includes('360 字符'));
    check('diagnostic detail still requires its own disclosure', !el('jev-status').checkVisibility() && !el('status-detail').checkVisibility());
    check('stored credentials never prefill the key field', el('jev-key').value === '' && el('jev-key').type === 'password');
    check('store release has no reference-difference entry', !el('jev-savings-enabled') && !el('savings-status'));
    el('jev-enabled').click();
    check('unsaved opt-out is not persisted', saved.jevEnabled && !el('save').disabled && el('refresh').disabled);
    check('unsaved preferences use pending rather than success feedback', el('notice').dataset.tone === 'pending');
    el('save').click(); await wait();
    check('AI opt-out saves without requesting permission', !saved.jevEnabled && permissions.length === 0 && el('notice').textContent.includes('已保存') && el('save').disabled);
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
    check('expanded settings have no horizontal overflow', document.documentElement.scrollWidth <= innerWidth);
    check('no runtime errors', errors.length === 0);
    report.completed = true;
  } catch (error) { report.error = error.message; }
  report.errors = errors;
  const output = document.createElement('pre');
  output.id = 'dom-results'; output.hidden = true; output.textContent = JSON.stringify(report); document.body.appendChild(output);
});
