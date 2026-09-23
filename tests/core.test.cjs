const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const C = require("../extension/shared.js");

const cases = [
  ["USD 1,299.99", "", "USD", 1299.99], ["1.299,99 €", "", "EUR", 1299.99],
  ["CHF 1’299.50", "", "CHF", 1299.5], ["€1\u202f299,90", "", "EUR", 1299.9],
  ["INR 1,23,456.78", "", "INR", 123456.78], ["GBP 1.299", "", "GBP", 1299],
  ["US$49.99", "", "USD", 49.99], ["C$12", "USD", "CAD", 12],
  ["USD $49.99", "", "USD", 49.99], ["$49.99 USD", "CAD", "USD", 49.99],
  ["-$19.95", "USD", "USD", -19.95], ["USD -9.50", "", "USD", -9.5],
  ["−€19,90", "", "EUR", -19.9], ["JPY 0", "", "JPY", 0],
  ["¥199", "JPY", "JPY", 199], ["$9.99", "CAD", "CAD", 9.99],
  ["99 元", "", "CNY", 99], ["￥10", "CNY", "CNY", 10],
  ["5パーセントの割引で￥587,998", "JPY", "JPY", 587998], ["税込￥100税込", "JPY", "JPY", 100],
];
test("international prices and explicit vs ambiguous currency", () => {
  for (const [text, hint, currency, amount] of cases) {
    const prices = C.findPrices(text, hint);
    assert.equal(prices.length, 1, text);
    assert.equal(prices[0].currency, currency, text);
    assert.equal(prices[0].amount, amount, text);
  }
  for (const text of ["$19.99", "¥100", "try 100", "2026", "SKU123", "USD 1,2,3", "USD 12.34.56", "USD 1234,567", "USDA 100", "USD 100foo", "€$12", "USD --12", "EUR 9 USD"]) {
    assert.equal(C.findPrices(text).length, 0, text);
  }
  assert.equal(C.findPrices("USD 10 / EUR 9 / HK$78").length, 3);
});

test("range separators do not turn explicit signed amounts or standalone refunds positive", () => {
  for (const text of ["Price range €10 -€20", "€10 - €20", "€10-€20", "€10–€20", "USD 10 -USD 20"]) {
    assert.deepEqual(C.findPrices(text).map((p) => p.amount), [10, 20], text);
  }
  for (const text of ["USD 10 USD -20", "USD 10, -USD 20", "USD 10 refund -USD 20"]) {
    assert.deepEqual(C.findPrices(text).map((p) => p.amount), [10, -20], text);
  }
  assert.deepEqual(C.findPrices("Price range €10 -€20").map((p) => p.original), ["€10", "€20"], "range connector is not a negative source amount in the detail view");
  assert.deepEqual(C.findPrices("-€20").map((p) => p.amount), [-20]);
  assert.deepEqual(C.findPrices("$10 -$20", "", true).map((p) => p.amount), [10, 20]);
});

test("conversion direction, rounding and corrupt rates", () => {
  const table = { rates: { USD: { rate: 0.125 }, EUR: { rate: 0.1 } } };
  assert.equal(C.convert(100, "USD", table), 800);
  assert.equal(C.convert(-100, "EUR", table), -1000);
  assert.equal(C.convert(1, "JPY", table), null);
  assert.equal(C.convert(1, "USD", { rates: { USD: { rate: 0 } } }), null);
  assert.equal(C.convert(1, "USD", { rates: { USD: { rate: Infinity } } }), null);
  assert.match(C.formatMoney(12.345, "CNY"), /12\.35/);
  assert.match(C.formatMoney(12.9, "JPY"), /13/);
  assert.equal(C.settingsFrom({ target: "__proto__" }).target, "CNY");
});

function worker(settings = {}, localData = {}, options = {}) {
  const sync = structuredClone({ ...C.DEFAULTS, ...settings });
  const local = structuredClone(localData);
  const calls = [];
  let access;
  let listener;
  let fail = false;
  let rows;
  const storage = (data, area) => ({
    async get(keys) {
      const snapshot = structuredClone(keys === null ? data : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, data[key]])));
      await options.beforeGet?.(area, keys);
      return snapshot;
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    async setAccessLevel(value) { access = value.accessLevel; },
  });
  const context = vm.createContext({
    PriceLens: C, importScripts() {}, AbortSignal, AbortController, URL, Date, console, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (fail) throw new Error("network down");
      if (url.includes("typesafe.ai")) {
        const payload = await optionsJevResponse(JSON.parse(options.body));
        return { ok: true, json: async () => payload };
      }
      const target = new URL(url).searchParams.get("source") || new URL(url).searchParams.get("base");
      const payload = rows || (url.includes("wise.com")
        ? [{ source: target, target: "USD", rate: 0.125, time: new Date().toISOString() }]
        : [{ base: target, quote: "USD", rate: 0.125, date: new Date().toISOString().slice(0, 10) }]);
      return { ok: true, json: async () => payload };
    },
    chrome: {
      permissions: { contains: async () => { await options.beforePermission?.(); return options.granted === true; } },
      tabs: { query: async () => [], sendMessage: async () => {} },
      storage: { sync: storage(sync, "sync"), local: storage(local, "local") },
      runtime: { id: "test", getURL: (path) => `chrome-extension://test/${path}`, onMessage: { addListener(fn) { listener = fn; } } },
    },
  });
  const optionsJevResponse = options.jevResponse || (() => ({ answers: {} }));
  vm.runInContext(fs.readFileSync(require.resolve("../extension/jev.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(require.resolve("../extension/background.js"), "utf8"), context);
  function send(message, trusted = true, url = "https://shop.test/") {
    return new Promise((resolve) => listener(message, { id: "test", url: trusted ? "chrome-extension://test/popup.html" : url }, resolve));
  }
  return { send, calls, local, sync, access: () => access, fail: () => { fail = true; }, rows: (r) => { rows = r; } };
}

test("ECB fetch, cache, deduplication and stale fallback", async () => {
  const w = worker();
  const results = await Promise.all([w.send({ type: "getRates" }), w.send({ type: "getRates" })]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(w.calls.length, 1);
  assert.equal(C.convert(10, "USD", results[0].table), 80);
  assert.ok(w.calls[0].url.includes("/providers/ecb/rates?base=CNY"));
  assert.equal(w.access(), "TRUSTED_CONTEXTS");
  await w.send({ type: "getRates" });
  assert.equal(w.calls.length, 1);
  w.fail();
  const stale = await w.send({ type: "getRates", force: true });
  assert.equal(stale.table.stale, true);
  assert.match(stale.table.warning, /失败/);
  assert.equal(w.calls.length, 2);
  const retry = await w.send({ type: "getRates", force: true });
  assert.equal(retry.table.stale, true);
  assert.equal(w.calls.length, 2, "back off failed requests");
  const contentRefresh = await w.send({ type: "getRates" }, false);
  assert.equal(contentRefresh.table.stale, true, "content scripts must also see the failed-refresh warning");
});

test("Wise auth stays in worker; only popup can edit; token rotation clears cache", async () => {
  const w = worker({ provider: "wise" }, { wiseToken: "fake-token" }, { granted: true });
  const publicState = await w.send({ type: "getState" }, false);
  assert.equal(publicState.hasToken, undefined);
  const result = await w.send({ type: "getRates" }, false);
  assert.equal(result.ok, true);
  assert.equal(w.calls[0].options.headers.Authorization, "Bearer fake-token");
  assert.ok(!JSON.stringify(result).includes("fake-token"));
  const denied = await w.send({ type: "saveSettings", settings: { ...C.DEFAULTS }, token: "stolen" }, false);
  assert.equal(denied.ok, false);
  assert.equal(w.local.wiseToken, "fake-token");
  const saved = await w.send({ type: "saveSettings", settings: { ...C.DEFAULTS, provider: "wise" }, token: "new-token" });
  assert.equal(saved.ok, true);
  assert.equal(w.local["rates:wise:CNY"], undefined);
  await w.send({ type: "getRates" });
  assert.equal(w.calls.at(-1).options.headers.Authorization, "Bearer new-token");
});

test("missing token, unsupported base, invalid response, obsolete cache fail closed", async () => {
  assert.equal((await worker({ provider: "wise" }).send({ type: "getRates" })).ok, false);
  assert.equal((await worker({ target: "TWD" }).send({ type: "getRates" })).ok, false);
  const broken = worker();
  broken.rows([{ base: "CNY", quote: "USD", rate: -1, date: "not-a-date" }]);
  assert.equal((await broken.send({ type: "getRates" })).ok, false);
  const old = worker({}, { "rates:ecb:CNY": { fetchedAt: Date.now() - 8 * 86_400_000, rates: { USD: { rate: 0.1 } } } });
  old.fail();
  assert.equal((await old.send({ type: "getRates" })).ok, false);
  const obsoleteQuote = worker({}, { "rates:ecb:CNY": { fetchedAt: Date.now(), rates: { USD: { rate: 0.1, asOf: new Date(Date.now() - 8 * 86_400_000).toISOString() } } } });
  obsoleteQuote.fail();
  assert.equal((await obsoleteQuote.send({ type: "getRates" })).ok, false, "a recent fetch must not extend an old quote's lifetime");
  const noToken = await worker().send({ type: "saveSettings", settings: { ...C.DEFAULTS, provider: "wise" }, token: null });
  assert.equal(noToken.ok, false);
});

const aiCases = require("./fixtures/jev-cases.json");
const choice = (value, confidence = 1) => ({ type: "choice", choice: value, confidence, probabilities: { [value]: 1 } });
function mockDecisions(body) {
  const { candidates } = JSON.parse(body.state);
  const answers = {};
  candidates.forEach((candidate, i) => {
    const sample = aiCases.find((item) => item.original === candidate.original);
    answers[`kind_${i}`] = choice(sample?.kind || "PRICE");
    answers[`currency_${i}`] = choice(sample?.modelCurrency || "CAD", sample?.confidence ?? 1);
  });
  return { model: "mock-only", answers };
}
const activeAI = { jevEnabled: true, jevKey: "fake-jev-key" };
const inference = (candidates = [aiCases[0]]) => ({ type: "inferJev", candidates: candidates.map(({ original, context }) => ({ original, context })) });

test("Jev simulated difficult cases: 0 to 3 resolved; 5 uncertain/unsafe cases remain skipped", async () => {
  assert.equal(aiCases.flatMap((item) => C.findPrices(item.original)).length, 0);
  const w = worker({}, activeAI, { granted: true, jevResponse: mockDecisions });
  const result = await w.send(inference(aiCases), false);
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.decisions), aiCases.map((item) => item.expected));
  const body = JSON.parse(w.calls[0].options.body);
  assert.equal(Object.keys(body.questions).length, 16);
  assert.equal(w.calls[0].options.headers.Authorization, "Bearer fake-jev-key");
  assert.ok(!JSON.stringify(body).includes("fake-jev-key"));
  assert.ok(!JSON.stringify(body).includes("shop.test"));
  assert.equal(w.calls[0].options.redirect, "error");
  const amount = C.findPrices(aiCases[0].original, "", true)[0].amount;
  assert.equal(amount, 49.99, "amount is parsed locally from the original, not returned by Jev");
  assert.equal(C.convert(amount, result.decisions[0], { rates: { CAD: { rate: 0.2 } } }), 249.95);
  await w.send(inference(aiCases), false);
  assert.equal(w.calls.length, 1, "identical candidates reuse memory cache");
});

test("Jev requires device-local opt-in, API permission, key and an allowed non-sensitive page", async () => {
  for (const [settings, local, options, url] of [
    [{ jevEnabled: true }, { jevKey: "key" }, { granted: true }, "https://shop.test/"],
    [{}, activeAI, { granted: false }, "https://shop.test/"],
    [{}, { jevEnabled: true }, { granted: true }, "https://shop.test/"],
    [{ enabled: false }, activeAI, { granted: true }, "https://shop.test/"],
    [{ excludedHosts: ["shop.test"] }, activeAI, { granted: true }, "https://shop.test/"],
    [{}, activeAI, { granted: true }, "https://shop.test/checkout"],
    [{}, activeAI, { granted: true }, "https://shop.test/account/orders"],
  ]) {
    const w = worker(settings, local, options);
    assert.equal((await w.send(inference(), false, url)).ok, false);
    assert.equal(w.calls.length, 0, "no request before consent or on excluded pages");
  }
  const w = worker({}, activeAI, { granted: true });
  assert.equal((await w.send(inference([{ original: "$12", context: "x".repeat(361) }]), false)).ok, false);
  assert.equal((await w.send(inference([{ original: "USD 12", context: "USD 12" }]), false)).ok, false);
  assert.equal(w.calls.length, 0);
  const state = await w.send({ type: "getState" }, false);
  assert.equal(state.hasJevKey, undefined);
  assert.ok(!JSON.stringify(state).includes("fake-jev-key"));
});

test("Jev failures/malformed answers fail closed; local conversion keeps working", async () => {
  const w = worker({}, activeAI, { granted: true, jevResponse: () => ({ answers: { kind_0: choice("PRICE"), currency_0: { ...choice("CAD"), confidence: "1" } } }) });
  assert.equal((await w.send(inference(), false)).decisions[0], null);
  const rates = await w.send({ type: "getRates" });
  assert.equal(rates.ok, true);
  assert.equal(C.convert(10, "USD", rates.table), 80);
  const offline = worker({}, activeAI, { granted: true });
  offline.fail();
  assert.equal((await offline.send(inference(), false)).ok, false);
  const status = await offline.send({ type: "getState" });
  assert.equal(status.jevStatus.state, "error");
  assert.ok(!status.jevStatus.message.includes("fake-jev-key"));
});

test("Jev settings stay local, keys never return, disabling cancels pending results", async () => {
  let release;
  let started;
  const begun = new Promise((resolve) => { started = resolve; });
  const w = worker({}, activeAI, { granted: true, jevResponse: (body) => { started(); return new Promise((resolve) => { release = () => resolve(mockDecisions(body)); }); } });
  const pending = w.send(inference(), false);
  await begun;
  const saved = await w.send({ type: "saveSettings", settings: { ...C.DEFAULTS, jevEnabled: false }, token: null, jevKey: "" });
  assert.equal(saved.ok, true);
  assert.equal(w.local.jevKey, undefined);
  assert.equal(w.local.jevEnabled, false);
  assert.notEqual(w.sync.jevEnabled, true);
  assert.ok(!JSON.stringify(saved).includes("fake-jev-key"));
  release();
  assert.equal((await pending).ok, false, "late results cannot re-enable AI or repopulate cache");
});

const legacyPair = {
  currencyHint: "USD", context: "Reference USD 100; current USD 80.",
  candidates: [{ original: "USD 100", group: "same-item" }, { original: "USD 80", group: "same-item" }],
};
const savingsMessage = (candidates = [legacyPair]) => ({ type: "inferJevSavings", candidates });
const savingsAI = { ...activeAI, jevSavingsEnabled: true };

test("store release rejects every savings request, including legacy opt-in", async () => {
  for (const [sync, local, options, url] of [
    [{}, savingsAI, { granted: true }, "https://shop.test/"],
    [{ jevSavingsEnabled: true }, activeAI, { granted: true }, "https://shop.test/"],
    [{}, { jevSavingsEnabled: true, jevKey: "key" }, { granted: true }, "https://shop.test/"],
    [{}, savingsAI, { granted: false }, "https://shop.test/"],
    [{ excludedHosts: ["shop.test"] }, savingsAI, { granted: true }, "https://shop.test/"],
    [{}, savingsAI, { granted: true }, "https://shop.test/checkout"],
  ]) {
    const w = worker(sync, local, options);
    assert.equal((await w.send(savingsMessage(), false, url)).ok, false);
    assert.equal(w.calls.length, 0);
  }
  const w = worker({}, savingsAI, { granted: true });
  const differentProducts = { ...legacyPair, candidates: legacyPair.candidates.map((candidate, i) => ({ ...candidate, group: `item-${i}` })) };
  assert.equal((await w.send(savingsMessage([differentProducts]), false)).ok, false, "different product groups never reach model");
  assert.equal((await w.send(savingsMessage([{ ...legacyPair, context: "x".repeat(361) }]), false)).ok, false);
  assert.equal(w.calls.length, 0);
});

function deferred() {
  let resolve;
  return { promise: new Promise((done) => { resolve = done; }), resolve: () => resolve() };
}

test("revocation during permission or key reads prevents any new AI upload", async () => {
  for (const waitingOn of ["permission", "key"]) for (const change of [{ jevEnabled: false }, { jevEnabled: true, enabled: false }, { jevEnabled: true, excludedHosts: ["shop.test"] }]) {
    const entered = deferred(), release = deferred();
    let once = true;
    const pause = async () => { if (once) { once = false; entered.resolve(); await release.promise; } };
    const w = worker({}, activeAI, {
      granted: true,
      beforePermission: waitingOn === "permission" ? pause : undefined,
      beforeGet: async (area, keys) => { if (waitingOn === "key" && area === "local" && keys === "jevKey") await pause(); },
    });
    const pending = w.send(inference(), false);
    await entered.promise;
    try {
      const saved = await w.send({ type: "saveSettings", settings: { ...C.DEFAULTS, ...change }, token: null, jevKey: null });
      assert.equal(saved.ok, true);
      assert.equal(w.calls.length, 0);
    } finally { release.resolve(); }
    assert.equal((await pending).ok, false);
    assert.equal(w.calls.length, 0, `${waitingOn}: no upload after revocation`);
  }
});

test("concurrent saves preserve credential rotation and a rejected save does not block later saves", async () => {
  const entered = deferred(), release = deferred();
  let once = true;
  const w = worker({}, { jevKey: "OLD-FAKE-KEY" }, { beforeGet: async (area, keys) => {
    if (once && area === "local" && Array.isArray(keys) && keys.includes("jevKey") && keys.includes("wiseToken")) {
      once = false; entered.resolve(); await release.promise;
    }
  } });
  const save = (jevKey) => w.send({ type: "saveSettings", settings: { ...C.DEFAULTS }, token: null, jevKey });
  const preserving = save(null);
  await entered.promise;
  const replacing = save("NEW-FAKE-KEY");
  release.resolve();
  assert.ok((await Promise.all([preserving, replacing])).every((r) => r.ok));
  assert.equal(w.local.jevKey, "NEW-FAKE-KEY");
  assert.equal((await save("invalid key")).ok, false);
  assert.equal((await save(null)).ok, true);
  assert.equal(w.local.jevKey, "NEW-FAKE-KEY");
  assert.equal((await save("")).ok, true);
  assert.equal(w.local.jevKey, undefined);
});

test("cache must match its provider, target and currency keys before reuse or fallback", async () => {
  const valid = { provider: "ecb", target: "CNY", fetchedAt: Date.now(), rates: { USD: { rate: 0.125, asOf: new Date().toISOString() } } };
  for (const table of [{ ...valid, provider: "wise" }, { ...valid, target: "EUR" }, { ...valid, rates: { XXX: valid.rates.USD } }, { ...valid, rates: [valid.rates.USD] }]) {
    const w = worker({}, { "rates:ecb:CNY": table });
    const result = await w.send({ type: "getRates" });
    assert.equal(result.ok, true);
    assert.equal(w.calls.length, 1, "invalid cache must be replaced");
    assert.equal(result.table.provider, "ecb");
    assert.equal(result.table.target, "CNY");
    const offline = worker({}, { "rates:ecb:CNY": table });
    offline.fail();
    assert.equal((await offline.send({ type: "getRates" })).ok, false, "invalid cache cannot be stale fallback");
  }
});

test("Wise permission is checked before credential-bearing requests and settings writes", async () => {
  const w = worker({ provider: "wise" }, { wiseToken: "fake-token" });
  assert.equal((await w.send({ type: "getRates" })).ok, false);
  assert.equal((await w.send({ type: "saveSettings", settings: { ...C.DEFAULTS, provider: "wise" }, token: "replacement" })).ok, false);
  assert.equal(w.calls.length, 0);
  assert.equal(w.local.wiseToken, "fake-token");
});

test("currency rejections are cached without exposing original page text", async () => {
  const answers = [
    { type: "choice", choice: "CAD", confidence: 0.22, probabilities: { CAD: 0.61, UNKNOWN: 0.39 } },
    { type: "choice", choice: "UNKNOWN", confidence: 1, probabilities: { UNKNOWN: 1 } },
    { type: "choice", choice: "CAD", confidence: 1, probabilities: { CAD: 0.4 } },
  ];
  for (const [index, reason] of ["lowConfidence", "unknown", "invalid"].entries()) {
    const w = worker({}, activeAI, { granted: true, jevResponse: () => ({ answers: { kind_0: choice("PRICE"), currency_0: answers[index] } }) });
    assert.equal((await w.send(inference(), false)).decisions[0], null);
    let status = (await w.send({ type: "getState" })).jevStatus;
    assert.match(status.message, /确认 0\/1 个候选/, reason);
    assert.equal(status.cached, false);
    assert.ok(!JSON.stringify(status).includes("JP¥"), "status must not expose page price text");
    assert.equal((await w.send(inference(), false)).decisions[0], null);
    status = (await w.send({ type: "getState" })).jevStatus;
    assert.match(status.message, /确认 0\/1 个候选/, reason);
    assert.equal(status.cached, true);
    assert.match(status.message, /缓存结果/);
    assert.equal(w.calls.length, 1);
  }
});

test("legacy savings flags cannot enable the store release on read or save", async () => {
  assert.equal(C.settingsFrom({ jevEnabled: true, jevSavingsEnabled: true }).jevSavingsEnabled, false);
  const w = worker({ jevSavingsEnabled: true }, savingsAI, { granted: true });
  assert.equal((await w.send({ type: "getState" }, false)).settings.jevSavingsEnabled, false);
  const saved = await w.send({ type: "saveSettings", settings: { ...C.DEFAULTS, jevEnabled: true, jevSavingsEnabled: true }, token: null, jevKey: null });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.jevSavingsEnabled, false);
  assert.equal(w.local.jevSavingsEnabled, false);
  assert.equal(saved.settings.jevEnabled, true, "ordinary currency AI remains available");
  assert.equal((await w.send(savingsMessage(), false)).ok, false);
  assert.equal(w.calls.length, 0);
});

test("Jev deduplicates concurrent batches and enforces a bounded request budget", async () => {
  const w = worker({}, activeAI, { granted: true, jevResponse: mockDecisions });
  const results = await Promise.all([w.send(inference(), false), w.send(inference(), false)]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(w.calls.length, 1);
  for (let i = 1; i <= 5; i++) {
    const original = `$${i}`;
    assert.equal((await w.send(inference([{ original, context: `Canadian dollar price ${original}` }]), false)).ok, true);
  }
  assert.equal(w.calls.length, 6);
  assert.equal((await w.send(inference([{ original: "$999", context: "Canadian dollar price $999" }]), false)).ok, false);
  assert.equal(w.calls.length, 6, "rate-limited candidates must not make another API request");
});
