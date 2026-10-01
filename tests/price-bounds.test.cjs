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
  for (const text of ['a price of £24.75 million', 'US$2,765 million', '$1.2 billion', '€5 bn', '$40 M', 'USD 10 mil', '¥3000万']) assert.deepEqual(C.findPrices(text, 'USD'), [], text);
  for (const text of ['$5 more', '$10 per million', '€12 Mo-Fr', '$20 bonus']) assert.equal(C.findPrices(text, 'USD').length, 1, `${text}: a word that only starts like a scale is not one`);
  for (const text of ['$0.125/oz', '€0,125', 'US$ 0.050', '$1.5M', '$2.5k', 'USD 19 99']) assert.deepEqual(C.findPrices(text, 'USD'), [], text);
  for (const [text, amount] of [['$0.99', 0.99], ['0,99 €', 0.99], ['$5.00.', 5], ['€10,-', 10], ['$1,000,000', 1e6], ['USD 1 299', 1299]]) assert.equal(C.findPrices(text, 'USD')[0]?.amount, amount, text);
});

test('manifest and package versions match', () => {
  assert.equal(require('../extension/manifest.json').version, require('../package.json').version);
});

test('locale packs stay in sync', () => {
  const pack = (l) => require(`../extension/_locales/${l}/messages.json`);
  assert.equal(require('../extension/manifest.json').default_locale, 'en');
  assert.deepEqual(Object.keys(pack('en')).sort(), Object.keys(pack('zh_CN')).sort());
  assert.deepEqual(pack('zh'), pack('zh_CN'), 'zh (zh-TW/zh-HK fallback) is a copy of zh_CN');
});

test('JSON-LD offer currencies are collected only from offers and known codes', () => {
  const list = (data) => [...C.structuredCurrencies(data)].sort();
  assert.deepEqual(list({ '@graph': [{ '@type': 'Product', offers: { '@type': 'AggregateOffer', lowPrice: 1, priceCurrency: 'CAD' } }] }), ['CAD']);
  assert.deepEqual(list([{ '@type': 'Offer', priceSpecification: { priceCurrency: 'GBP' } }, { '@type': 'Offer', priceCurrency: 'USD' }]), ['GBP', 'USD']);
  assert.deepEqual(list({ '@type': 'Organization', currenciesAccepted: 'JPY', priceCurrency: 'JPY' }), [], 'non-offer nodes are not price evidence');
  assert.deepEqual(list({ '@type': 'Offer', priceCurrency: 'XXX' }), []);
});

test('inline data currencies: declared keys only, every code kept so conflicts are visible', () => {
  const list = (text) => [...C.dataCurrencies(text).all].sort();
  assert.deepEqual(list('{"props":{"price":{"amount":59.99,"currency":"USD"}}}'), ['USD']);
  assert.deepEqual(list('window.__STATE__={"currencyCode": "CAD","x":{"priceCurrency":"CAD","currency_code":"CAD"}}'), ['CAD']);
  assert.deepEqual(list('{"currency":"USD","other":{"currency":"EUR"}}'), ['EUR', 'USD'], 'multi-currency data is a conflict, not a vote');
  assert.deepEqual(list('{"currency":"KWD"}'), ['KWD'], 'unsupported codes still count toward a conflict');
  assert.deepEqual(list('Shopify.currency = {"active":"CAD","rate":"1.36"}; {"currencyCode":"USD"}'), ['CAD', 'USD'], 'Shopify presentment currency contradicts the shop base');
  // The veto side is broad on purpose: lower-case codes, nested {code}, JS literals with single quotes.
  assert.deepEqual(list('{"currency":"usd"}'), ['USD']);
  assert.deepEqual(list('{"session":{"currency":{"code":"CAD","symbol":"$"}}}'), ['CAD']);
  assert.deepEqual(list("window.storeConfig = { displayCurrency: 'CAD' }; gtag('set', { currency: 'CAD' })"), ['CAD']);
  assert.deepEqual(list('var currency = "USD"'), ['USD']);
  // A store's own default/base currency is not a displayed currency, so it is no conflict (real Amazon shape).
  assert.deepEqual(list('{"locale":"zh_CN","currencyIsoCode":"JPY","defaultCurrencyIsoCode":"USD"}'), ['JPY']);
  // Store/shop/base keys stay in: some platforms use them for the displayed currency, so a mismatch must veto.
  assert.deepEqual(list('{"shop_currency":"USD","baseCurrency":"USD","displayCurrency":"CAD"}'), ['CAD', 'USD']);
  assert.deepEqual(list('{"storeCurrency":"CAD","price":19.99,"currency":"USD"}'), ['CAD', 'USD']);
  assert.deepEqual(list('{"shopperCurrency":"CAD","amount":19.99,"currency":"USD"}'), ['CAD', 'USD']);
  // Every code inside a currency object or list counts, not only the first one.
  assert.deepEqual(list('Shopify.currency={"code":"USD","active":"CAD","rate":"1.3"}'), ['CAD', 'USD']);
  assert.deepEqual(list("Shopify.currency = {code:'USD', active:'CAD'};"), ['CAD', 'USD']);
  assert.deepEqual(list('{"currencies":["USD","CAD","EUR"]}'), ['CAD', 'EUR', 'USD'], 'a supported-currency list means the display can differ');
  assert.deepEqual(list('{"availableCurrencies":[{"code":"USD"},{"code":"CAD"}]}'), ['CAD', 'USD']);
  assert.deepEqual(list('{"supportedCurrencies":["USD"]}'), ['USD']);
  assert.deepEqual(list('{"displayCurrency":"CAD","selectedCurrency":"USD"}'), ['CAD', 'USD'], 'two displayed currencies still conflict');
  for (const text of ['{"currencies":["USA","CAN"]}', '{"language":"en-US","country":"US"}', '{"currencyDisplay":"symbol"}', null]) {
    assert.deepEqual(list(text), [], String(text));
  }
});

test('inline data currencies: escaped JSON (RSC) and display/presentment keys count as conflict evidence', () => {
  const list = (text) => [...C.dataCurrencies(text).all].sort();
  const positive = (text) => [...C.dataCurrencies(text).positive].sort();

  // Escaped JSON in Next.js RSC is detected as conflict evidence
  assert.deepEqual(list('self.__next_f.push([1,"{\\"currency\\":\\"CAD\\"}"])'), ['CAD']);
  assert.deepEqual(list('self.__next_f.push([1,"{\\"currency\\":\\"CAD\\",\\"displayCurrency\\":\\"USD\\"}"])'), ['CAD', 'USD']);

  // Display/presentment/selection keys and Shopify active are veto-only, never positive sources
  for (const snippet of [
    '{"displayCurrency":"CAD"}',
    '{"presentmentCurrency":"CAD"}',
    '{"selectedCurrency":"CAD"}',
    '{"currency_code":"CAD"}',
    'Shopify.currency = {"active":"CAD","rate":"1.36"};',
  ]) {
    assert.deepEqual(list(snippet), ['CAD'], `all includes CAD: ${snippet}`);
    assert.deepEqual(positive(snippet), [], `positive excludes veto-only key: ${snippet}`);
  }
});

test('inline data currencies: positive evidence must be price-shaped, unrelated config is veto-only', () => {
  const list = (text) => [...C.dataCurrencies(text).all].sort();
  const positive = (text) => [...C.dataCurrencies(text).positive].sort();

  // Real-site price-shaped cases: currency sits in same JSON object as price/amount
  // 1. Nintendo __NEXT_DATA__
  const nintendo = '{"props":{"pageProps":{"products":[{"name":"Game","prices":{"regular":{"amount":59.99,"currency":"CAD"}}}]}}}';
  assert.deepEqual(positive(nintendo), ['CAD']);
  assert.deepEqual(list(nintendo), ['CAD']);

  // 2. GOG #gogcom-store-state
  const gog = '{"price":{"amount":"19.99","currency":"USD"}}';
  assert.deepEqual(positive(gog), ['USD']);
  assert.deepEqual(list(gog), ['USD']);

  // 3. Xbox inline store state (real shape): a nested object sits between the prices' siblings and the currency is last
  const xbox = '{"discountPercentage":15.0,"eligibilityInfo":{"eligibility":"None","type":"Unknown"},"hasXPriceOffer":false,"listPrice":59.49,"msrp":69.99,"currency":"USD"},"skuId":"0010"}';
  assert.deepEqual(positive(xbox), ['USD']);
  assert.deepEqual(list(xbox), ['USD']);

  // 4. Escaped Next.js RSC price object
  const rscPrice = 'self.__next_f.push([1,"{\\"prices\\":{\\"regular\\":{\\"amount\\":59.99,\\"currency\\":\\"CAD\\"}}}"])';
  assert.deepEqual(positive(rscPrice), ['CAD']);

  // 5. Explicit priceCurrency
  assert.deepEqual(positive('{"priceCurrency":"CAD"}'), ['CAD']);

  // Negative side: unrelated configs (free shipping, dataLayer analytics) are veto-only, never positive
  const freeShipping = '{"freeShipping":{"currency":"USD"}}';
  assert.deepEqual(list(freeShipping), ['USD']);
  assert.deepEqual(positive('{"price":10,"meta":{"x":1},"shipping":{"currency":"USD","minimum":50}}'), [], 'a price and a currency in different objects are not tied');
  assert.deepEqual(positive(freeShipping), [], 'free shipping config without price object is not positive evidence');

  const freeShippingThreshold = '{"freeShipping":{"amount":50,"currency":"USD"}}';
  assert.deepEqual(list(freeShippingThreshold), ['USD']);
  assert.deepEqual(positive(freeShippingThreshold), [], 'shipping threshold is not positive product price evidence');

  for (const text of ['{"freeShippingMinimum":{"amount":50,"currency":"USD"}}', '{"shippingThreshold":{"amount":50,"currency":"USD"}}',
    'dataLayer.push({"event":"view_item","items":[{"id":"a1","name":"A very long product name for padding purposes"}],"ecommerce":{"value":59.99,"currency":"USD"}})']) {
    assert.deepEqual(positive(text), [], text);
  }
  for (const text of ['{"taxPrice":80,"currency":"CNY"}', '{"deliveryPrice":5.99,"currency":"USD"}', '{"currency":"USD","handlingFeePrice":3}']) {
    assert.deepEqual(positive(text), [], `checkout amounts are not shelf prices: ${text}`);
  }
  const analytics = 'dataLayer=[{"ecommerce":{"currency":"USD"}}]';
  assert.deepEqual(list(analytics), ['USD']);
  assert.deepEqual(positive(analytics), [], 'dataLayer ecommerce object without price object is not positive evidence');
});

test('inline data scanning stays linear on long hex, word and backslash runs', () => {
  for (const text of ["a".repeat(1_000_000), "\\".repeat(1_000_000), "\\\"".repeat(300_000), ("0123456789abcdef".repeat(4) + "Currency").repeat(20_000)]) {
    const start = performance.now();
    C.dataCurrencies(text);
    assert.ok(performance.now() - start < 300, `${text.length} chars took ${Math.round(performance.now() - start)} ms`);
  }
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
