const { test } = require('node:test');
const assert = require('node:assert/strict');
globalThis.chrome = { i18n: require("./i18n.cjs").i18n() }; // shared.js reads UI text through chrome.i18n
const C = require('../extension/shared.js');

test('trailing starting-price markers retain bounds without becoming closed ranges', () => {
  for (const text of ['¥939,800～', '¥939,800〜', '¥939,800～ 税込']) {
    const [price] = C.findPrices(text, 'JPY');
    assert.equal(price.amount, 939800);
    assert.equal(price.currency, 'JPY');
    assert.equal(price.minimum, true);
    assert.match(price.original, /[～〜]$/);
  }
  for (const text of ['JPY 100～JPY 200', 'JPY 100〜 200', 'JPY 100～JPY ¥200']) {
    assert.notEqual(C.findPrices(text)[0]?.minimum, true, 'closed range is not a starting-price claim');
  }
  assert.equal(C.findPrices('¥939,800～').length, 0, 'a starting marker cannot guess currency');
});

test('starting prices cannot enter reference/current subtraction', () => {
  const pair = originals => ({ currencyHint: 'JPY', candidates: originals.map(original => ({ original, group: 'same-item' })) });
  assert.equal(C.pairSavings(pair(['JPY 1000', 'JPY 800～']), 'A_REFERENCE_B_CURRENT'), null);
  assert.equal(C.pairSavings(pair(['JPY 1000～', 'JPY 800']), 'A_REFERENCE_B_CURRENT'), null);
  assert.equal(C.pairSavings(pair(['JPY 1000', 'JPY 800']), 'A_REFERENCE_B_CURRENT').amount, 200);
});

test('schema.org sale markup yields exactly one reference/current pair per offer', () => {
  const keys = (data) => [...C.structuredSavings(data)];
  const strike = (price, extra = {}) => ({ '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/StrikethroughPrice', price, priceCurrency: 'GBP', ...extra });
  assert.deepEqual(keys({ '@graph': [{ '@type': 'Product', offers: [{ '@type': 'Offer', price: '10.00', priceCurrency: 'GBP', priceSpecification: strike(15) }] }] }), ['GBP:15>10']);
  assert.deepEqual(keys({ '@type': 'Offer', priceSpecification: [{ price: 10, priceCurrency: 'GBP' }, strike('15.00')] }), ['GBP:15>10']);
  assert.deepEqual(keys({ '@type': 'Offer', price: 8, priceCurrency: 'USD', priceSpecification: { priceType: 'ListPrice', price: 9, priceCurrency: 'USD' } }), ['USD:9>8']);
  assert.deepEqual(keys({ '@type': 'Offer', price: 10, priceCurrency: 'GBP', priceSpecification: [strike(15), { price: 8, priceCurrency: 'GBP', validForMemberTier: { name: 'gold' } }] }), ['GBP:15>10'], 'member tier is ignored');
  for (const [name, data] of [
    ['no reference', { '@type': 'Offer', price: 10, priceCurrency: 'GBP' }],
    ['reference not higher', { '@type': 'Offer', price: 15, priceCurrency: 'GBP', priceSpecification: strike(15) }],
    ['currency mismatch', { '@type': 'Offer', price: 10, priceCurrency: 'USD', priceSpecification: strike(15) }],
    ['two different current prices', { '@type': 'Offer', price: 10, priceCurrency: 'GBP', priceSpecification: [strike(15), { price: 9, priceCurrency: 'GBP' }] }],
    ['unit price is not a current price', { '@type': 'Offer', priceSpecification: [strike(15), { price: 10, priceCurrency: 'GBP', referenceQuantity: { value: 1 } }] }],
    ['expired sale', { '@type': 'Offer', priceCurrency: 'GBP', priceSpecification: [strike(15), { price: 10, priceCurrency: 'GBP', validThrough: '2000-01-01' }] }],
    ['aggregate offer range', { '@type': 'AggregateOffer', lowPrice: 10, highPrice: 15, priceCurrency: 'GBP' }],
    ['non-numeric price', { '@type': 'Offer', price: '10,00', priceCurrency: 'GBP', priceSpecification: strike(15) }],
    ['unknown currency', { '@type': 'Offer', price: 10, priceCurrency: 'XXX', priceSpecification: { ...strike(15), priceCurrency: 'XXX' } }],
  ]) assert.deepEqual(keys(data), [], name);
});

test('sensitive paths are shared by AI and reference-difference guards', () => {
  for (const path of ['/checkout', '/cart/', '/account/settings', '/orders/123', '/order.html', '/login?next=/', '/payment_method', '/checkouts/c/abc', '/accounts', '/signin', '/sign-in', '/basket', '/#/checkout']) assert.equal(C.isSensitivePath(path), true, path);
  for (const path of ['/', '/products/cartridge-ink', '/accounting-books', '/category/shoes']) assert.equal(C.isSensitivePath(path), false, path);
});

test('amounts that would silently scale are skipped, not misread', () => {
  for (const text of ['$0.125/oz', '€0,125', 'US$ 0.050', '$1.5M', '$2.5k', 'USD 19 99']) assert.deepEqual(C.findPrices(text, 'USD'), [], text);
  for (const [text, amount] of [['$0.99', 0.99], ['0,99 €', 0.99], ['$5.00.', 5], ['€10,-', 10], ['$1,000,000', 1e6], ['USD 1 299', 1299]]) assert.equal(C.findPrices(text, 'USD')[0]?.amount, amount, text);
});

test('manifest and package versions match', () => {
  assert.equal(require('../extension/manifest.json').version, require('../package.json').version);
});

test('JSON-LD offer currencies are collected only from offers and known codes', () => {
  const list = (data) => [...C.structuredCurrencies(data)].sort();
  assert.deepEqual(list({ '@graph': [{ '@type': 'Product', offers: { '@type': 'AggregateOffer', lowPrice: 1, priceCurrency: 'CAD' } }] }), ['CAD']);
  assert.deepEqual(list([{ '@type': 'Offer', priceSpecification: { priceCurrency: 'GBP' } }, { '@type': 'Offer', priceCurrency: 'USD' }]), ['GBP', 'USD']);
  assert.deepEqual(list({ '@type': 'Organization', currenciesAccepted: 'JPY', priceCurrency: 'JPY' }), [], 'non-offer nodes are not price evidence');
  assert.deepEqual(list({ '@type': 'Offer', priceCurrency: 'XXX' }), []);
});

test('local savings: markup first, then exactly one struck vs one unstruck amount', () => {
  const item = (context, ...entries) => ({ context, currencyHint: '', candidates: entries.map(([original, struck]) => ({ original, group: 'item', struck })) });
  const pair = item('x', ['GBP 15', false], ['GBP 10', false], ['GBP 2', false]);
  assert.equal(C.localSavings(pair, new Set(['GBP:15>10'])).source, 'structured');
  assert.equal(C.localSavings(pair, new Set(['GBP:15>10'])).amount, 5);
  assert.equal(C.localSavings(pair), null, 'three unstruck amounts need markup');
  const struck = C.localSavings(item('x', ['USD 80', false], ['USD 100', true]));
  assert.equal(struck.source, 'strike');
  assert.equal(struck.amount, 20);
  assert.equal(struck.currentIndex, 0);
  for (const [name, input] of [
    ['no strike', item('x', ['USD 100', false], ['USD 80', false])],
    ['both struck', item('x', ['USD 100', true], ['USD 80', true])],
    ['struck lower than current', item('x', ['USD 5', true], ['USD 9', false])],
    ['currency mismatch', item('x', ['USD 100', true], ['EUR 80', false])],
    ['member wording', item('Member price', ['USD 100', true], ['USD 80', false])],
    ['coupon wording', item('クーポン適用', ['USD 100', true], ['USD 80', false])],
    ['three amounts', item('x', ['USD 100', true], ['USD 80', false], ['USD 5', false])],
    ['starting price', item('x', ['JPY 1000', true], ['JPY 800～', false])],
  ]) assert.equal(C.localSavings(input), null, name);
  assert.equal(C.localSavings(item('x', ['GBP 15', false], ['GBP 10', false]), new Set(['GBP:15>10', 'GBP:15>9'])).source, 'structured', 'unrelated page pairs do not block a match');
});
