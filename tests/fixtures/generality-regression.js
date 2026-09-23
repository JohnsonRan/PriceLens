// Synthetic evidence/amount boundaries; no live extension APIs or network.
const listeners = [], errors = [];
const settings = { ...PriceLens.DEFAULTS };
const quote = rate => ({ rate, asOf: new Date().toISOString() });
const table = { provider: 'ecb', target: 'CNY', fetchedAt: Date.now(), stale: false, rates: { USD: quote(.125), CAD: quote(.25), EUR: quote(.1) } };
window.addEventListener('error', e => errors.push(e.message));
window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
window.chrome = { runtime: { sendMessage: async m => m.type === 'getState' ? { ok: true, settings } : { ok: true, table }, onMessage: { addListener: fn => listeners.push(fn) } }, storage: { onChanged: { addListener() {} } } };
window.addEventListener('load', async () => {
  const result = { completed: false, systemDark: matchMedia('(prefers-color-scheme: dark)').matches, checks: [] };
  const el = id => document.getElementById(id);
  const badges = id => {
    const nodes = [...el(id).querySelectorAll('[data-pricelens]')];
    for (let n = el(id).nextElementSibling; n?.matches('[data-pricelens]'); n = n.nextElementSibling) nodes.push(n);
    return nodes;
  };
  const amounts = id => badges(id).map(n => n.textContent.trim());
  const wait = () => new Promise(resolve => setTimeout(resolve, 280));
  const check = (name, pass, detail) => result.checks.push({ name, pass: Boolean(pass), detail });
  try {
    await wait();
    check('currency evidence never crosses product cards', badges('unknown').length === 0, amounts('unknown'));
    check('own card currency still converts', amounts('known').some(t => t.includes('40.00')), amounts('known'));
    check('currency evidence never crosses sibling Offers', badges('unknown-offer').length === 0, amounts('unknown-offer'));
    for (const id of ['hidden-tail', 'css-tail', 'transparent-tail', 'aria-tail']) {
      check(id + ': invisible digits cannot change the amount', badges(id).length === 1 && amounts(id)[0].includes('80.00'), amounts(id));
    }
    check('range upper endpoint remains positive', badges('range').length === 2 && amounts('range')[1].includes('200.00') && !amounts('range')[1].includes('-'), amounts('range'));
    check('explicit negative amount after currency is preserved', amounts('signed').some(t => t.includes('-CNY') && t.includes('160.00')), amounts('signed'));
    const controls = [...document.querySelectorAll('.pricelens-price[data-pricelens]')];
    check('price annotations use native buttons with exactly one Tab entry', controls.every(b => b.tagName === 'BUTTON' && b.type === 'button' && b.getAttribute('aria-haspopup') === 'dialog') && controls.filter(b => b.tabIndex === 0).length === 1);
    controls[0].focus();
    controls[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    check('arrow navigation moves focus without adding Tab stops', document.activeElement === controls[1] && controls.filter(b => b.tabIndex === 0).length === 1);
    check('annotation buttons never nest inside host links or buttons', badges('interactive').length === 2 && badges('interactive').every(b => !b.parentElement.closest('a,button')), amounts('interactive'));
    let hostClicks = 0;
    el('interactive').addEventListener('click', () => hostClicks++);
    badges('interactive')[0].click(); await wait();
    let dialog = document.querySelector('dialog.pricelens-details');
    check('click/tap opens native modal without activating host control', dialog?.open && hostClicks === 0 && !location.hash && dialog.contains(document.activeElement));
    check('modal visibly contains rate basis and disclaimer', dialog?.querySelector('p').textContent.includes('报价时间') && dialog?.querySelector('p').textContent.includes('仅供参考') && dialog.getBoundingClientRect().width <= innerWidth);
    dialog.querySelector('button').click(); await wait();
    check('closing details removes modal and restores trigger focus', !dialog.isConnected && document.activeElement === badges('interactive')[0]);
    check('initial local metadata converts', amounts('dynamic').some(t => t.includes('80.00')), amounts('dynamic'));
    badges('dynamic')[0].click();
    dialog = document.querySelector('dialog.pricelens-details');
    el('currency-meta').content = 'CAD'; await wait();
    check('open details follow updated quote instead of showing stale basis', dialog.open && dialog.querySelector('p').textContent.includes('(CAD)') && dialog.querySelector('p').textContent.includes('40.00'));
    dialog.dispatchEvent(new Event('cancel', { cancelable: true })); await wait();
    check('native Escape cancel path removes details and restores focus', !dialog.isConnected && document.activeElement === badges('dynamic')[0]);
    check('metadata-only change updates sibling price', amounts('dynamic').some(t => t.includes('40.00')) && !amounts('dynamic').some(t => t.includes('80.00')), amounts('dynamic'));
    const conflicting = document.createElement('meta'); conflicting.setAttribute('itemprop', 'priceCurrency'); conflicting.content = 'USD'; el('dynamic').append(conflicting); await wait();
    check('conflicting metadata removes conversion', badges('dynamic').length === 0, amounts('dynamic'));
    conflicting.remove(); await wait();
    check('removing conflict restores local conversion', amounts('dynamic').some(t => t.includes('40.00')), amounts('dynamic'));
    el('currency-meta').removeAttribute('itemprop'); await wait();
    check('removing metadata role invalidates sibling conversion', badges('dynamic').length === 0, amounts('dynamic'));
    el('currency-meta').setAttribute('itemprop', 'priceCurrency'); await wait();
    check('restoring metadata role rescans price', amounts('dynamic').some(t => t.includes('40.00')), amounts('dynamic'));
    el('currency-meta').remove(); await wait();
    check('removing last metadata removes conversion', badges('dynamic').length === 0, amounts('dynamic'));
    el('currency-text').firstChild.data = 'CAD'; await wait();
    check('text metadata mutation updates price', amounts('text-metadata').some(t => t.includes('40.00')), amounts('text-metadata'));
    badges('hidden-tail')[0].click();
    settings.enabled = false;
    listeners.forEach(fn => fn({ type: 'refresh' })); await wait();
    check('disabling conversion closes details and clears all annotations', !document.querySelector('[data-pricelens]'));
    check('no runtime errors', errors.length === 0, errors);
    result.completed = true;
  } catch (error) { result.error = String(error); }
  el('dom-results').textContent = JSON.stringify(result);
});
