const { test } = require('node:test');
const assert = require('node:assert/strict');

test('manifest and package versions match', () => {
  assert.equal(require('../extension/manifest.json').version, require('../package.json').version);
});

test('locale packs stay in sync', () => {
  const pack = (l) => require(`../extension/_locales/${l}/messages.json`);
  assert.equal(require('../extension/manifest.json').default_locale, 'en');
  assert.deepEqual(Object.keys(pack('en')).sort(), Object.keys(pack('zh')).sort());
});
