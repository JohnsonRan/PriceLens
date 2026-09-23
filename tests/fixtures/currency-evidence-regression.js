// No model requests or user input reads: actual content script with isolated mock settings/rates.
const calls = [], errors = [];
window.addEventListener('error', e => errors.push(e.message));
window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
globalThis.chrome = {
  runtime: {
    sendMessage: async message => {
      calls.push(message.type);
      if (message.type === 'getState') return { ok: true, settings: { ...PriceLens.DEFAULTS } };
      if (message.type === 'getRates') return { ok: true, table: { provider: 'ecb', target: 'CNY', rates: { JPY: { rate: 20, asOf: '2026-09-22' }, USD: { rate: 0.14, asOf: '2026-09-22' } }, fetchedAt: Date.now(), stale: false } };
      throw new Error('Unexpected request: ' + message.type);
    },
    onMessage: { addListener() {} },
  },
  storage: { onChanged: { addListener() {} } },
};
window.addEventListener('load', async () => {
  const result = { completed: false, systemDark: matchMedia('(prefers-color-scheme: dark)').matches, checks: [] };
  const el = id => document.getElementById(id);
  const badges = id => [...el(id).querySelectorAll('[data-pricelens]')];
  const wait = () => new Promise(resolve => setTimeout(resolve, 350));
  const check = (name, value) => result.checks.push({ name, pass: Boolean(value) });
  try {
    await wait();
    check('explicit price-filter 円 resolves split yen quote without AI', badges('plain')[0]?.textContent.includes('292,805.75'));
    check('split starting quote converts and preserves its lower-bound meaning', badges('starting')[0]?.textContent.includes('46,990.00') && badges('starting')[0].textContent.includes('起') && el('starting').querySelector('p').textContent === '¥939,800～');
    check('explicit USD wins over page JPY and incompatible dollar stays unknown', badges('explicit').length === 1 && badges('ambiguous').length === 0);
    const badge = badges('plain')[0];
    el('local-filter').id = 'other-filter'; el('plain').querySelector('p').className = 'unrelated-markup';
    await wait();
    check('no site ID or class is required and appearance changes preserve the badge', badges('plain')[0] === badge);
    el('unit').textContent = '¥'; await wait();
    check('ambiguous filter symbol, arbitrary 円 text and ad-tracker JPY cannot decide currency', badges('plain').length === 0 && badges('starting').length === 0);
    el('unit').textContent = 'JPY'; await wait();
    check('changing the explicit filter unit re-evaluates existing prices', badges('plain').length === 1);
    const form = el('other-filter');
    form.hidden = true; await wait();
    check('hidden filters cannot supply a page currency', badges('plain').length === 0);
    form.hidden = false; await wait();
    check('showing the filter restores supported conversion', badges('plain').length === 1);
    const conflict = document.createElement('form');
    conflict.innerHTML = '<div><input name="min_price"> ～ <input name="max_price"> 元</div>';
    document.body.append(conflict); await wait();
    check('conflicting explicit filter units do not guess a page currency', badges('plain').length === 0);
    conflict.remove(); await wait();
    check('removing conflicting evidence restores one supported unit', badges('plain').length === 1);
    const product = document.createElement('article'); document.body.append(product); product.append(form); await wait();
    check('a product-local range form cannot set the currency for the entire page', badges('plain').length === 0);
    document.body.prepend(form); product.remove(); await wait();
    form.action = 'https://unrelated.example/search'; await wait();
    check('off-page forms cannot set current-page pricing units', badges('plain').length === 0);
    form.action = ''; await wait();
    form.querySelector('[name="minp"]').name = 'minweight'; await wait();
    check('unrelated range fields cannot provide a price-filter hint', badges('plain').length === 0);
    check('filter values are untouched and never sent', form.querySelector('[name="minweight"]').value === 'never-send-min' && form.querySelector('[name="maxp"]').value === 'never-send-max' && calls.every(type => ['getState', 'getRates'].includes(type)));
    check('no runtime errors', errors.length === 0);
    result.completed = true;
  } catch (error) { result.error = error.message; }
  result.errors = errors; el('dom-results').textContent = JSON.stringify(result);
});
