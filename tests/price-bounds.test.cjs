const { test } = require('node:test');
const assert = require('node:assert/strict');
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
