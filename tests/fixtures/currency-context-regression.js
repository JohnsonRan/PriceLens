// Mock classification only. Real-model observations are recorded separately; no network requests here.
const calls = [], errors = [], delayed = [];
let defer = false;
window.addEventListener('error', e => errors.push(e.message));
window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
const classify = c => {
  const codes = [...new Set(c.context.match(/\b(?:USD|CAD|CNY|JPY)\b/g) || [])];
  return /not a product price/.test(c.context) || codes.length !== 1 ? null : codes[0];
};
globalThis.chrome = {
  runtime: { onMessage: { addListener() {} }, sendMessage: async m => {
    if (m.type === 'getState') return { ok: true, settings: { ...PriceLens.DEFAULTS, target: 'EUR', jevEnabled: true, jevSavingsEnabled: false } };
    if (m.type === 'getRates') return { ok: true, table: { provider: 'ecb', target: 'EUR', rates: Object.fromEntries(Object.entries({ USD: 1.1, CAD: 1.5, JPY: 160, CNY: 7.9 }).map(([c, rate]) => [c, { rate, asOf: '2026-09-22' }])), fetchedAt: Date.now(), stale: false } };
    if (m.type !== 'inferJev') throw new Error('Unexpected request: ' + m.type);
    calls.push(...m.candidates);
    const result = { ok: true, decisions: m.candidates.map(classify) };
    if (!defer) return result;
    return new Promise(resolve => delayed.push(() => resolve(result)));
  } },
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
    check('four differently structured quote scopes can render correct mock decisions', [['lamp-usd','45.00'],['plan-cad','50.00'],['bag-jpy','100.00'],['chair-cny','100.00']].every(([id,n]) => badges(id).length === 1 && badges(id)[0].textContent.includes(n)));
    check('all enriched payloads retain original text and the 360-character limit', calls.length === 8 && calls.every(c => c.context.length <= 360 && c.context.includes(c.original)));
    check('the distant local pricing statements reach the model without site or language rules', calls.find(c=>c.original==='$49.50')?.context.includes('US dollars (USD)') && calls.find(c=>c.original==='¥790.00')?.context.includes('人民币（CNY）'));
    check('negative decisions never acquire badges', ['shipping-only','conflicting-policy','format-example','neighbor-policy'].every(id=>badges(id).length===0));
    check('another product policy never enters the first quote context', !calls.find(c=>c.original==='$34.00')?.context.includes('USD'));
    check('short complete context keeps the beginning of a non-price disclaimer', calls.find(c=>c.original==='$33.00')?.context.startsWith('Number-format documentation'));
    const card = el('lamp-usd'), note = card.querySelector('p');
    const originalNote = note.textContent;
    const firstBadge = badges('lamp-usd')[0], beforeTheme = calls.length;
    card.style.backgroundColor = '#111'; await wait();
    check('theme-only changes preserve the node without another classification', badges('lamp-usd')[0] === firstBadge && calls.length === beforeTheme);
    note.style.display = 'none'; await wait();
    check('hiding the policy outside the price element invalidates its currency', badges('lamp-usd').length === 0 && !calls.at(-1).context.includes('USD'));
    note.style.display = ''; await wait();
    check('restoring visible evidence reuses a known decision', badges('lamp-usd').length === 1);
    defer = true;
    note.textContent = 'Revised policy: all displayed amounts are in CAD.';
    await wait();
    check('changing neighboring evidence clears the old currency while a new decision is pending', badges('lamp-usd').length === 0 && delayed.length === 1);
    delayed.shift()(); await wait();
    check('a new currency decision changes only the local conversion', badges('lamp-usd')[0]?.textContent.includes('33.00') && card.querySelector('b').textContent === '$49.50');
    note.textContent = 'Next policy: all displayed amounts are in USD.'; await wait();
    note.textContent = 'Latest policy: all displayed amounts are in CAD.'; await wait();
    delayed.shift()(); await wait();
    check('a late response for superseded context cannot display its currency', badges('lamp-usd').length === 0 && delayed.length === 1);
    delayed.shift()(); await wait(); defer = false;
    check('the latest context may then render its own result', badges('lamp-usd')[0]?.textContent.includes('33.00'));
    note.textContent = 'Listed amounts use USD. Contact fixture@example.com or +1 (202) 555-0142.';
    await wait();
    const last = calls.at(-1);
    check('existing privacy redaction applies to the wider local context', last.context.includes('[邮箱已移除]') && last.context.includes('[长数字已移除]') && !last.context.includes('fixture@example.com'));
    const privateForm = document.createElement('form');
    privateForm.innerHTML = '<p>Private CAD account label</p><input value="never-upload-private-value">';
    const privateCount = calls.length; card.append(privateForm); await wait();
    check('form text and input values are not added to context', calls.length === privateCount && calls.every(c=>!c.context.includes('Private CAD') && !c.context.includes('never-upload-private-value')));
    privateForm.remove();
    note.textContent = 'x'.repeat(370) + ' Do not treat the preceding amount as a price. USD';
    await wait();
    check('oversized context is not cropped into a false affirmative snippet', badges('lamp-usd').length === 0 && !calls.at(-1).context.includes('xxx'));
    note.textContent = originalNote; await wait();
    card.remove(); document.body.classList.add('appearance-change'); await wait();
    check('removed scopes and their annotations are cleaned up without errors', !document.getElementById('lamp-usd') && errors.length === 0);
    check('no script errors', errors.length === 0);
    result.completed = true;
  } catch (e) { result.error = e.message; }
  result.errors = errors; el('dom-results').textContent = JSON.stringify(result);
});
