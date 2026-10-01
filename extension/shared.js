/* Shared by the popup, isolated content script, service worker and Node checks. */
(() => {
  // Supported codes only; display names come from the browser's CLDR data in any UI language.
  // Deliberately excluded: codes that are also common words (ALL, TOP, CUP, MAD, PEN, COP, GEL, CRC, MOP, ...)
  // and 3-decimal currencies (KWD, BHD, OMR, JOD, TND), whose "12.500" parseAmount would read as thousands.
  const CODES = ("CNY USD EUR GBP JPY HKD TWD SGD AUD CAD NZD CHF KRW THB INR MYR IDR PHP VND SEK NOK DKK ISK PLN CZK HUF RON TRY BRL MXN ZAR ILS AED SAR RUB " +
    "ARS CLP EGP PKR NGN KZT UAH QAR BDT KES LKR").split(" ");
  // UI text comes from _locales via chrome.i18n: en is the default, zh is the fallback for zh-TW/zh-HK.
  const t = (key, ...subs) => globalThis.chrome?.i18n?.getMessage(key, subs.map(String)) || key;
  const uiLocale = () => globalThis.chrome?.i18n?.getUILanguage?.() || "zh-CN";
  const currencyName = (code, locale = uiLocale()) => new Intl.DisplayNames([locale], { type: "currency" }).of(code);
  const CURRENCIES = Object.freeze(Object.fromEntries(CODES.map((code) => [code, true])));
  const ECB_CURRENCIES = "AUD BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR".split(" ");
  const DEFAULTS = Object.freeze({ enabled: true, target: "CNY", provider: "ecb", sourceHint: "", excludedHosts: [], siteHints: {}, feePercent: 0, savingsEnabled: true, jevEnabled: false });
  const HOST = /^[a-z0-9.:[\]-]+$/i;
  const SYMBOLS = {
    "US$": "USD", "CA$": "CAD", "C$": "CAD", "AU$": "AUD", "A$": "AUD",
    "NZ$": "NZD", "HK$": "HKD", "SG$": "SGD", "S$": "SGD", "NT$": "TWD",
    "R$": "BRL", "CN¥": "CNY", "JP¥": "JPY", "€": "EUR", "£": "GBP",
    "₹": "INR", "₩": "KRW", "฿": "THB", "₫": "VND", "₱": "PHP",
    "₺": "TRY", "₽": "RUB", "zł": "PLN", "元": "CNY", "円": "JPY",
  };
  const AMBIGUOUS = { "$": ["USD", "CAD", "AUD", "NZD", "HKD", "SGD", "TWD", "MXN", "ARS", "CLP"], "¥": ["CNY", "JPY"], "￥": ["CNY", "JPY"] };
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokens = [...Object.keys(CURRENCIES), ...Object.keys(SYMBOLS), ...Object.keys(AMBIGUOUS)].sort((a, b) => b.length - a.length).map(escape).join("|");
  const space = "[ \\t\\u00a0\\u202f]*";
  const number = "[+−-]?\\d(?:[\\d.,'’ \\u00a0\\u202f]*\\d)?";
  const cjk = "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]";
  const SCALE = /^[ \t\u00a0\u202f]*(?:(?:thousand|million|billion|trillion|mil|mln|mn|bn|tn|mio|mrd|m|b|k|t)s?\b|[万萬億亿千百])/iu;
  const pattern = new RegExp(`(?:(?<![\\p{L}\\p{N}_])|(?<=${cjk}))(?:([+−-]?)(${tokens})${space}([$¥￥]?)${space}(${number})|(${number})${space}(${tokens}))(?:(?![\\p{L}\\p{N}_]|[.,'’]\\d)|(?=${cjk}))`, "gu");

  // Checkout, payment, account, login, order and cart paths: no AI upload and no reference-difference labels.
  const SENSITIVE_PATH = /(?:checkouts?|payments?|accounts?|log-?in|sign-?in|orders?|carts?|basket)(?:[/.?_-]|$)/i;
  const isSensitivePath = (pathname) => SENSITIVE_PATH.test(pathname);

  function currencyFor(token, hint) {
    return CURRENCIES[token] ? token : SYMBOLS[token] || (AMBIGUOUS[token]?.includes(hint) ? hint : null);
  }

  function parseAmount(input) {
    let value = input.trim().replace(/−/g, "-");
    let sign = 1;
    if (/^[+-]/.test(value)) {
      sign = value[0] === "-" ? -1 : 1;
      value = value.slice(1);
    }
    if (!/^\d[\d.,'’\s]*$/u.test(value)) return null;
    const dots = value.includes(".");
    const commas = value.includes(",");
    let decimal = "";
    if (dots && commas) decimal = value.lastIndexOf(".") > value.lastIndexOf(",") ? "." : ",";
    else if (dots || commas) {
      const separator = dots ? "." : ",";
      const parts = value.split(separator);
      if (parts.length === 2 && /^\d{1,2}$/.test(parts[1])) decimal = separator;
    }
    const parts = decimal ? value.split(decimal) : [value];
    if (parts.length > 2 || (decimal && !/^\d{1,2}$/.test(parts[1]))) return null;
    const integer = parts[0].replace(/[\s’]/gu, "'");
    const separators = [...integer.matchAll(/[^\d]/g)].map((m) => m[0]);
    if (new Set(separators).size > 1) return null;
    if (separators.length) {
      const groups = integer.split(separators[0]);
      // Accept international groups and Indian lakh/crore groups; reject malformed amounts.
      // A leading 0 group ("0.125") is a 3-decimal amount, not thousands; skip it rather than misread it.
      const western = /^[1-9]\d{0,2}$/.test(groups[0]) && groups.slice(1).every((g) => /^\d{3}$/.test(g));
      const indian = /^[1-9]\d?$/.test(groups[0]) && /^\d{3}$/.test(groups.at(-1)) && groups.slice(1, -1).every((g) => /^\d{2}$/.test(g));
      if (!western && !indian) return null;
    }
    const result = sign * Number(integer.replace(/[^\d]/g, "") + (decimal ? `.${parts[1]}` : ""));
    return Number.isFinite(result) && Math.abs(result) <= Number.MAX_SAFE_INTEGER / 100 ? result : null;
  }

  function findPrices(text, hint = "", includeUnresolved = false) {
    const prices = [];
    const matcher = new RegExp(pattern);
    for (const match of text.matchAll(matcher)) {
      const [, sign, prefix, innerSymbol, prefixAmount, suffixAmount, suffix] = match;
      const token = prefix || suffix;
      let currency = currencyFor(token, hint);
      let end = match.index + match[0].length;
      if (prefix) {
        const trailing = text.slice(end).match(/^[ \t\u00a0\u202f]*([A-Z]{3})(?![\p{L}\p{N}_])/u);
        // Do not consume a trailing ISO token when it starts the next complete price.
        if (trailing && CURRENCIES[trailing[1]] && new RegExp(pattern).exec(text.slice(end).trimStart())?.index !== 0) {
          const explicit = trailing[1];
          if (AMBIGUOUS[token]?.includes(explicit)) currency = explicit;
          else if (currency !== explicit) continue;
          end += trailing[0].length;
        }
      }
      if ((!currency && !(includeUnresolved && AMBIGUOUS[token])) || (innerSymbol && !AMBIGUOUS[innerSymbol]?.includes(currency))) continue;
      const amount = parseAmount(prefixAmount || suffixAmount);
      if (amount === null || (sign && /^[+−-]/.test(prefixAmount))) continue;
      // "£24.75 million", "$1.2 bn", "$3 M": a scale word makes the digits a fraction of the amount. Skip, never misread.
      if (SCALE.test(text.slice(end, end + 16))) continue;
      // A trailing wave is an open-ended starting price, not a fixed amount or a closed range.
      const marker = text.slice(end).match(/^[ \t\u00a0\u202f]*[～〜]/u);
      const rest = marker ? text.slice(end + marker[0].length).trimStart() : "";
      const minimum = marker && !/^[+−-]?\d/u.test(rest) && new RegExp(pattern).exec(rest)?.index !== 0;
      if (minimum) end += marker[0].length;
      let signedAmount = amount * (sign === "-" || sign === "−" ? -1 : 1);
      let start = match.index;
      const previous = prices.at(-1);
      // Only a sign BEFORE a currency token can join adjacent range endpoints.
      // A sign inside the amount (USD -20), standalone negatives and refunds keep their sign.
      if ((sign === "-" || sign === "−") && signedAmount < 0 && previous?.amount >= 0 && previous.currency === currency &&
          (currency || previous.possibleCurrencies.join() === AMBIGUOUS[token]?.join()) &&
          /^\s*$/u.test(text.slice(previous.end, match.index))) {
        signedAmount = -signedAmount;
        start += sign.length; // The range connector is not part of the upper price's verbatim amount.
      }
      prices.push({ start, end, original: text.slice(start, end), currency, amount: signedAmount, possibleCurrencies: currency ? [] : [...AMBIGUOUS[token]], ...(minimum ? { minimum: true } : {}) });
    }
    return prices.filter((price, i) => i === 0 || price.start >= prices[i - 1].end);
  }

  function settingsFrom(value = {}) {
    return {
      enabled: value.enabled !== false,
      savingsEnabled: value.savingsEnabled !== false,
      jevEnabled: value.jevEnabled === true,
      target: Object.hasOwn(CURRENCIES, value.target) ? value.target : DEFAULTS.target,
      provider: value.provider === "wise" ? "wise" : "ecb",
      sourceHint: Object.hasOwn(CURRENCIES, value.sourceHint) ? value.sourceHint : "",
      excludedHosts: Array.isArray(value.excludedHosts) ? value.excludedHosts.filter((s) => typeof s === "string" && HOST.test(s)).slice(0, 200) : [],
      // Per-site source currency: resolves ambiguous symbols on that host only; wins over the global hint.
      siteHints: value.siteHints && typeof value.siteHints === "object" && !Array.isArray(value.siteHints)
        ? Object.fromEntries(Object.entries(value.siteHints).filter(([host, code]) => HOST.test(host) && Object.hasOwn(CURRENCIES, code)).slice(0, 200)) : {},
      // Card foreign-transaction fee, added to cross-currency conversions only.
      feePercent: typeof value.feePercent === "number" && value.feePercent >= 0 && value.feePercent <= 10 ? Math.round(value.feePercent * 100) / 100 : 0,
    };
  }

  function convert(amount, source, table, feePercent = 0) {
    const rate = table?.rates?.[source]?.rate;
    // APIs return units of source currency per ONE unit of the user's target currency.
    return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? amount / rate * (1 + feePercent / 100) : null;
  }

  // Own keys only: a host named "constructor" must not read Object.prototype.
  const siteHintFor = (settings, host) => Object.hasOwn(settings.siteHints ?? {}, host) ? settings.siteHints[host] : "";
  // Manual hint for a host: this site's choice, else the global one, else none.
  const manualHint = (settings, host) => siteHintFor(settings, host) || settings.sourceHint || "";

  function pairSavings(input, referenceIndex, currentIndex) {
    if (referenceIndex === currentIndex || !Array.isArray(input?.candidates) || input.candidates.length < 2 || input.candidates.length > 4) return null;
    const candidates = [input.candidates[referenceIndex], input.candidates[currentIndex]];
    if (typeof candidates[0]?.group !== "string" || !candidates[0].group || candidates[0].group !== candidates[1]?.group) return null;
    const prices = candidates.map((candidate) => {
      if (typeof candidate?.original !== "string" || candidate.original.length > 80) return null;
      const found = findPrices(candidate.original, input.currencyHint);
      return found.length === 1 && found[0].start === 0 && found[0].end === candidate.original.length ? found[0] : null;
    });
    const [reference, current] = prices;
    if (!reference || !current || reference.minimum || current.minimum || reference.currency !== current.currency || current.amount <= 0 || reference.amount <= current.amount) return null;
    const high = Math.round(reference.amount * 100), low = Math.round(current.amount * 100);
    if (!Number.isSafeInteger(high) || !Number.isSafeInteger(low)) return null;
    return { reference, current, amount: (high - low) / 100, currency: current.currency, referenceIndex, currentIndex };
  }

  const REFERENCE_TYPE = /(?:^|[/#:])(?:StrikethroughPrice|ListPrice|MSRP|SRP)$/;
  const schemaAmount = (value) => {
    const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
    return /^\d+(?:\.\d+)?$/.test(text) && Number(text) > 0 ? Number(text) : null;
  };

  // Explicit schema.org sale markup (Google merchant listings): Offer.price or an untyped
  // UnitPriceSpecification is current; priceType StrikethroughPrice/ListPrice marks the reference.
  function schemaNodes(root, types) {
    const found = [], stack = [root];
    for (let budget = 5000; stack.length && budget > 0; budget--) {
      const node = stack.pop();
      if (Array.isArray(node)) { stack.push(...node); continue; }
      if (!node || typeof node !== "object") continue;
      for (const value of Object.values(node)) if (value && typeof value === "object") stack.push(value);
      if ([].concat(node["@type"]).some((type) => types.includes(type))) found.push(node);
    }
    return found;
  }

  // Offer-level currency metadata: same trust level as og:price:currency, never inferred from language or domain.
  function structuredCurrencies(root) {
    const currencies = new Set();
    for (const node of schemaNodes(root, ["Offer", "AggregateOffer"])) {
      for (const value of [node, ...[].concat(node.priceSpecification ?? [])].map((item) => item?.priceCurrency)) if (Object.hasOwn(CURRENCIES, value)) currencies.add(value);
    }
    return currencies;
  }

  // Inline page data (app state, analytics, storefront config, currency switchers) can name currencies two ways:
  // - `all`: every code any *currency* key declares, in any quoting (JSON, escaped RSC JSON, JS object literals with
  //   single quotes), any case, or nested as {code: ...}/{active: ...}. Any second code vetoes the page hint, so this
  //   side is deliberately broad: widening it can only make PriceLens convert less.
  // - `positive`: a code tied to a price, i.e. a currency key and a numeric price/amount key in the same object
  //   (no brace between them), or an explicit priceCurrency. Only this side can supply a page hint.
  // All quantifiers are bounded: the scan runs on every page's inline scripts, and unbounded \w* or \\* made long
  // hex or backslash runs take seconds.
  const Q = String.raw`\\{0,8}['"]`; // A quote, possibly escaped (RSC payloads nest JSON inside JS strings).
  const K = String.raw`(?:\\{0,8}['"])?`; // Keys may be unquoted in JS object literals.
  // A marketplace's default currency is not what it displays (Amazon: currencyIsoCode is the shopper's chosen
  // currency, defaultCurrencyIsoCode the marketplace's), so only such keys are left out. Other names (store, shop, base,
  // settlement) are used by some platforms for the displayed currency, so they stay in and can veto.
  const DEFAULT_KEY = /default|fallback/i;
  // A currency key with one code, an object ({code, active, iso, ...}) or a list (supported currencies).
  const DATA_CURRENCY = new RegExp(String.raw`\b(\w{0,40}[cC]urrenc(?:y|ies)\w{0,40})${K}\s*[:=]\s*(?:${Q}([A-Za-z]{3})${Q}|(\{[^{}]{0,200}\}|\[[^\[\]]{0,600}\]))`, "g");
  // Inside an object or list every code counts: {code: "USD", active: "CAD"} is two currencies, not the first one.
  const QUOTED_CODE = new RegExp(String.raw`${Q}([A-Za-z]{3})${Q}`, "g");
  const ISO = new Set(Intl.supportedValuesOf("currency"));
  const CODE_KEY = String.raw`${Q}(?:currency|currencyCode|currency_code)${Q}\s*:\s*${Q}([A-Z]{3})${Q}`;
  const AMOUNT_KEY = String.raw`${Q}(?:\w{0,40}[Pp]rice|[Aa]mount|[Vv]alue|[Mm]srp)${Q}\s*:\s*(?:${Q})?\d[\d,]{0,20}(?:\.\d{1,4})?`;
  const PRICE_CURRENCY = new RegExp(String.raw`${CODE_KEY}[^{}]{0,400}?${AMOUNT_KEY}|${AMOUNT_KEY}[^{}]{0,400}?${CODE_KEY}|${Q}(?:priceCurrency|price_currency)${Q}\s*:\s*${Q}([A-Z]{3})${Q}`, "g");
  // Price-shaped objects that are not product prices: free-shipping thresholds, analytics/ecommerce events.
  const NOT_PRODUCT = /ship|threshold|minimum|free|ecommerce|datalayer|analytics|tracking|gtag/i;
  // A tax, delivery or fee amount is priced in the checkout's currency, not necessarily the shelf's.
  const NOT_ITEM_AMOUNT = /(?:tax|deliver|duty|handling|fee|surcharge|deposit)\w{0,20}[Pp]rice/i;

  function dataCurrencies(text) {
    const all = new Set(), positive = new Set();
    if (typeof text !== "string") return { all, positive };
    for (const match of text.matchAll(DATA_CURRENCY)) {
      if (DEFAULT_KEY.test(match[1])) continue;
      if (match[2]) { all.add(match[2].toUpperCase()); continue; }
      for (const [, code] of match[3].matchAll(QUOTED_CODE)) if (ISO.has(code.toUpperCase())) all.add(code.toUpperCase());
    }
    for (const match of text.matchAll(PRICE_CURRENCY)) {
      // The enclosing object's own key (just before its opening brace) and its sibling keys decide what it prices.
      const open = text.lastIndexOf("{", match.index);
      if (NOT_PRODUCT.test(text.slice(Math.max(0, open - 40), match.index + match[0].length)) || NOT_ITEM_AMOUNT.test(match[0])) continue;
      positive.add(match[1] || match[2] || match[3]);
    }
    return { all, positive };
  }

  function structuredSavings(root) {
    const pairs = new Set();
    for (const node of schemaNodes(root, ["Offer"])) {
      const now = Date.now();
      const specs = [].concat(node.priceSpecification ?? []).filter((spec) => spec && typeof spec === "object" && !spec.validForMemberTier && !spec.referenceQuantity &&
        !(Date.parse(spec.validThrough) < now) && !(Date.parse(spec.validFrom) > now));
      const values = (list) => new Set(list.map((spec) => ({ amount: schemaAmount(spec.price), currency: spec.priceCurrency ?? node.priceCurrency }))
        .filter((price) => price.amount && Object.hasOwn(CURRENCIES, price.currency)).map((price) => `${price.currency}:${price.amount}`));
      const current = values([...specs.filter((spec) => spec.priceType == null), ...(node.price == null ? [] : [node])]);
      const reference = values(specs.filter((spec) => REFERENCE_TYPE.test(String(spec.priceType ?? ""))));
      if (current.size !== 1 || reference.size !== 1) continue;
      const [[currency, low]] = [...current].map((id) => id.split(":")), [[referenceCurrency, high]] = [...reference].map((id) => id.split(":"));
      if (currency === referenceCurrency && Number(high) > Number(low)) pairs.add(`${currency}:${Number(high)}>${Number(low)}`);
    }
    return pairs;
  }

  // ponytail: keyword list, not language understanding; unlisted conditions fall through to strike evidence.
  const CONDITIONAL = /member|subscri|coupon|voucher|promo ?code|会员|會員|会員|订阅|訂閱|定期|优惠券|優惠券|クーポン|ポイント|积分/i;

  // Deterministic reference/current pairing: page markup first, then one struck vs one unstruck amount.
  function localSavings(input, structured = new Set()) {
    const n = input?.candidates?.length || 0;
    const found = [];
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      const pair = a !== b && pairSavings(input, a, b);
      if (pair && structured.has(`${pair.currency}:${pair.reference.amount}>${pair.current.amount}`)) found.push(pair);
    }
    if (found.length === 1) return { ...found[0], source: "structured" };
    if (found.length || n !== 2 || CONDITIONAL.test(input.context || "")) return null;
    const struck = input.candidates.findIndex((candidate) => candidate.struck === true);
    if (struck < 0 || input.candidates[1 - struck].struck === true) return null;
    const pair = pairSavings(input, struck, 1 - struck);
    return pair && { ...pair, source: "strike" };
  }

  function formatMoney(amount, currency) {
    return new Intl.NumberFormat(uiLocale(), { style: "currency", currency, currencyDisplay: "code" }).format(amount);
  }

  const api = { t, uiLocale, isSensitivePath, currencyName, CURRENCIES, ECB_CURRENCIES, DEFAULTS, currencyFor, parseAmount, findPrices, settingsFrom, convert, siteHintFor, manualHint, formatMoney, pairSavings, structuredCurrencies, dataCurrencies, structuredSavings, localSavings };
  globalThis.PriceLens = Object.freeze(api);
  if (typeof module !== "undefined") module.exports = api;
})();
