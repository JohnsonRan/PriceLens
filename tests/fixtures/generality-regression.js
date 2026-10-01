// Synthetic evidence/amount boundaries; no live extension APIs or network.
const listeners = [], errors = [];
const settings = { ...PriceLens.DEFAULTS };
const quote = rate => ({ rate, asOf: new Date().toISOString() });
const table = { provider: 'ecb', target: 'CNY', fetchedAt: Date.now(), stale: false, rates: { USD: quote(.125), CAD: quote(.25), EUR: quote(.1) } };
// Apple-style right column exactly as wide as the badge: it fits on its own line only without its leading gap.
{
  const probe = Object.assign(document.createElement('button'), { className: 'pricelens-price', textContent: ` ≈ ${PriceLens.formatMoney(29980 / .125, 'CNY')}` });
  probe.setAttribute('data-pricelens', '');
  document.getElementById('narrow-col').append(probe);
  document.getElementById('narrow-col').style.width = Math.ceil(probe.getBoundingClientRect().width) + 1 + 'px';
  probe.remove();
}
window.addEventListener('error', e => errors.push(e.message));
window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
// Mock Jev: settles only "$13" (as USD); every other symbol-only price stays unsure.
const jev = m => ({ ok: true, decisions: m.candidates.map(c => c.original === '$13' ? 'USD' : null) });
window.chrome = { i18n: window.PL_I18N, runtime: { sendMessage: async m => m.type === 'getState' ? { ok: true, settings: { ...settings } } : m.type === 'inferJev' ? jev(m) : { ok: true, table }, onMessage: { addListener: fn => listeners.push(fn) } }, storage: { onChanged: { addListener() {} } } };
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
  const send = (message) => { let reply; listeners.forEach(fn => fn(message, {}, (r) => { reply = r; })); return reply; };
  const pageStatus = () => send({ type: 'pageStatus' });
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  // Until the page reports no scan or AI answer due (bounded).
  const settle = async () => { for (let i = 0; i < 100 && (!i || pageStatus()?.pending); i++) await sleep(20); };
  try {
    await wait();
    check('a far wrapper\x27s data-currency outside any card is not this price\x27s currency', badges('deep-wrapper').length === 0, amounts('deep-wrapper'));
    check('currency evidence never crosses product cards', badges('unknown').length === 0, amounts('unknown'));
    check('own card currency still converts', amounts('known').some(t => t.includes('40.00')), amounts('known'));
    check('currency evidence never crosses sibling Offers', badges('unknown-offer').length === 0, amounts('unknown-offer'));
    for (const id of ['hidden-tail', 'css-tail', 'transparent-tail', 'aria-tail']) {
      check(id + ': invisible digits cannot change the amount', badges(id).length === 1 && amounts(id)[0].includes('80.00'), amounts(id));
    }
    check('styled cents without <sup> are never read as whole units', !amounts('split-cents').some(t => t.includes('15,992')), amounts('split-cents'));
    el('carousel').append(el('carousel').firstElementChild.cloneNode(true)); await wait();
    check('cloned slides keep exactly one tracked badge each', [...el('carousel').children].every(slide => slide.querySelectorAll('[data-pricelens]').length === 1) && amounts('carousel').length === 2, amounts('carousel'));
    check('superscript cents join the amount', amounts('sup-cents').length === 1 && amounts('sup-cents')[0].includes('159.92'), amounts('sup-cents'));
    check('superscript currency mark and cents join the amount', amounts('sup-symbol').length === 1 && amounts('sup-symbol')[0].includes('60.00'), amounts('sup-symbol'));
    check('dot-thousands amount takes superscript cents as a comma decimal', amounts('sup-euro').length === 1 && amounts('sup-euro')[0].includes('12,999.00'), amounts('sup-euro'));
    check('a one-digit footnote is not cents and the amount is not truncated', badges('sup-footnote').length === 0, amounts('sup-footnote'));
    check('a unit exponent never becomes cents', amounts('sup-unit').length === 1 && amounts('sup-unit')[0].includes('96.00'), amounts('sup-unit'));
    check('range upper endpoint remains positive', badges('range').length === 2 && amounts('range')[1].includes('200.00') && !amounts('range')[1].includes('-'), amounts('range'));
    check('explicit negative amount after currency is preserved', amounts('signed').some(t => t.includes('-CNY') && t.includes('160.00')), amounts('signed'));
    {
      const column = el('narrow-col').getBoundingClientRect(), tag = badges('narrow-col')[0]?.getBoundingClientRect();
      check('a badge wrapped into a column exactly its width drops its leading gap instead of disappearing', tag && tag.left >= column.left - 1 && tag.right <= column.right + 1 && amounts('narrow-col')[0].includes('239,840.00'), amounts('narrow-col'));
      check('a badge beside its price on the same line keeps its gap', parseFloat(getComputedStyle(badges('known')[0]).marginInlineStart) > 0, getComputedStyle(badges('known')[0]).marginInlineStart);
    }
    const controls = [...document.querySelectorAll('button.pricelens-price[data-pricelens]')];
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
    {
      const label = el('card-link').querySelector('[data-pricelens]');
      check('a price deep inside a product-card link gets a plain label inside the link', label?.tagName === 'SPAN' && label.closest('a') && badges('card-link').length === 1 && label.textContent.includes('240.00'), amounts('card-link'));
      check('the in-link label is not a control: no Tab stop, no popup role, details on hover', !label.hasAttribute('tabindex') && !label.hasAttribute('aria-haspopup') && !label.hasAttribute('aria-label') && label.title.includes('USD 30'));
      let prevented = null, linkClicks = 0;
      el('card-link').addEventListener('click', (e) => { linkClicks++; prevented = e.defaultPrevented; e.preventDefault(); });
      label.click(); await wait();
      check('clicking the label follows the host link instead of opening details', linkClicks === 1 && prevented === false && !document.querySelector('dialog.pricelens-details'));
    }
    check('prices with no room beside them in a tight flex/grid card get no tag', badges('unplaced-grid').length === 0, amounts('unplaced-grid'));
    check('plain labels exist only inside host controls and never take focus', [...document.querySelectorAll('span.pricelens-price[data-pricelens]')].every((s) => s.parentElement.closest('a[href],button') && !s.hasAttribute('tabindex')));
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
    {
      const status = pageStatus();
      check('page status counts visible prices skipped for an ambiguous symbol (two cards, the metadata-less dynamic price and the far-wrapper price), with symbols and counts only', status?.active && status.skipped === 4 && JSON.stringify(status.symbols) === '["$"]' && status.pending === false && Object.keys(status).sort().join() === 'active,ok,pending,skipped,symbols', status);
    }
    settings.siteHints = { [location.hostname]: 'USD' }; listeners.forEach(fn => fn({ type: 'refresh' })); await wait();
    check('setting this site\'s currency clears the skipped count', pageStatus()?.skipped === 0, pageStatus());
    check('this site\x27s currency resolves an otherwise ambiguous $', amounts('unknown').some(t => t.includes('80.00')), amounts('unknown'));
    check('the user\x27s site currency never overrides a card\x27s own markup, however deep the price sits', amounts('known').some(t => t.includes('40.00')) && amounts('deep-card').some(t => t.includes('20.00')), [amounts('known'), amounts('deep-card')]);
    settings.siteHints = {}; listeners.forEach(fn => fn({ type: 'refresh' })); await wait();
    check('removing the site currency goes back to skipping', badges('unknown').length === 0, amounts('unknown'));
    {
      // One counting path with AI on and off: the same units, visibility rules and symbols.
      const counts = async () => {
        const base = pageStatus().skipped, out = {};
        el('spellings').hidden = false; await settle();
        out.spellings = pageStatus().skipped - base; out.symbols = pageStatus().symbols.join(' ');
        el('spellings').hidden = true; await settle();
        out.spellingsHidden = pageStatus().skipped - base;
        el('slide-a').style.display = 'block'; await settle();
        out.slideA = pageStatus().skipped - base;
        el('slide-a').style.display = 'none'; el('slide-b').style.display = 'block'; await settle();
        out.slideB = pageStatus().skipped - base;
        el('slide-b').style.display = 'none'; await settle();
        out.slidesHidden = pageStatus().skipped - base;
        out.pending = pageStatus().pending;
        return out;
      };
      el('ai-toggle').hidden = false; await settle();
      const total = pageStatus().skipped;
      const off = await counts();
      check('without AI, suffix, split, superscript and range spellings count per price, with symbols normalised to $ and ¥', off.spellings === 7 && off.symbols === '$ ¥' && off.spellingsHidden === 0, off);
      check('without AI, a carousel slide counts only while it is shown', off.slideA === 1 && off.slideB === 1 && off.slidesHidden === 0 && off.pending === false, off);
      settings.jevEnabled = true; listeners.forEach(fn => fn({ type: 'refresh' }));
      check('a settings change reports a pending scan instead of a settled count', pageStatus().pending === true, pageStatus());
      await settle(); await settle();
      check('turning AI on: a price it settles converts and is no longer counted as skipped', amounts('ai-toggle').some(t => t.includes('104.00') && t.includes('AI')) && pageStatus().skipped === total - 1 && pageStatus().pending === false, [amounts('ai-toggle'), pageStatus(), total]);
      const on = await counts();
      check('with AI on (unsure about these), exactly the same prices are counted', JSON.stringify(on) === JSON.stringify(off), [on, off]);
      settings.jevEnabled = false; listeners.forEach(fn => fn({ type: 'refresh' })); await settle();
      check('turning AI off again counts that price once more, exactly once', badges('ai-toggle').length === 0 && pageStatus().skipped === total, [pageStatus(), total]);
      el('ai-toggle').hidden = true; await settle();
    }
    settings.feePercent = 10; listeners.forEach(fn => fn({ type: 'refresh' })); await wait();
    check('card fee is added to cross-currency badges and explained', amounts('known').some(t => t.includes('44.00')) && badges('known')[0].title.includes('10%'), amounts('known'));
    settings.feePercent = 0; listeners.forEach(fn => fn({ type: 'refresh' })); await wait();
    check('removing the fee restores plain conversions', amounts('known').some(t => t.includes('40.00')), amounts('known'));
    listeners.forEach(fn => fn({ type: 'showConversion', text: '<b>USD 10</b> ≈ CNY 80' }));
    check('right-click result opens in the page dialog as plain text', document.querySelector('dialog[open] p')?.textContent === '<b>USD 10</b> ≈ CNY 80' && !document.querySelector('dialog b'));
    settings.excludedHosts = [location.hostname]; listeners.forEach(fn => fn({ type: 'refresh' })); await wait();
    check('a refresh on a paused site does not dismiss the right-click result', document.querySelector('dialog[open]'));
    settings.excludedHosts = []; listeners.forEach(fn => fn({ type: 'refresh' })); await wait();
    document.querySelector('dialog[open] button').click();
    check('right-click dialog closes', !document.querySelector('dialog'));
    badges('hidden-tail')[0].click();
    settings.enabled = false;
    listeners.forEach(fn => fn({ type: 'refresh' })); await wait();
    check('disabling conversion closes details and clears all annotations', !document.querySelector('[data-pricelens]'));
    check('no runtime errors', errors.length === 0, errors);
    result.completed = true;
  } catch (error) { result.error = String(error); }
  el('dom-results').textContent = JSON.stringify(result);
});
