/* Shared by the popup, isolated content script, service worker and Node checks. */
(() => {
  const CURRENCIES = Object.freeze({
    CNY: "人民币", USD: "美元", EUR: "欧元", GBP: "英镑", JPY: "日元",
    HKD: "港元", TWD: "新台币", SGD: "新加坡元", AUD: "澳元", CAD: "加拿大元",
    NZD: "新西兰元", CHF: "瑞士法郎", KRW: "韩元", THB: "泰铢", INR: "印度卢比",
    MYR: "马来西亚林吉特", IDR: "印尼盾", PHP: "菲律宾比索", VND: "越南盾",
    SEK: "瑞典克朗", NOK: "挪威克朗", DKK: "丹麦克朗", ISK: "冰岛克朗",
    PLN: "波兰兹罗提", CZK: "捷克克朗", HUF: "匈牙利福林", RON: "罗马尼亚列伊",
    TRY: "土耳其里拉", BRL: "巴西雷亚尔", MXN: "墨西哥比索", ZAR: "南非兰特",
    ILS: "以色列新谢克尔", AED: "阿联酋迪拉姆", SAR: "沙特里亚尔", RUB: "俄罗斯卢布",
  });
  const ECB_CURRENCIES = "AUD BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR".split(" ");
  const DEFAULTS = Object.freeze({ enabled: true, target: "CNY", provider: "ecb", sourceHint: "", excludedHosts: [], jevEnabled: false, jevSavingsEnabled: false });
  const SYMBOLS = {
    "US$": "USD", "CA$": "CAD", "C$": "CAD", "AU$": "AUD", "A$": "AUD",
    "NZ$": "NZD", "HK$": "HKD", "SG$": "SGD", "S$": "SGD", "NT$": "TWD",
    "R$": "BRL", "CN¥": "CNY", "JP¥": "JPY", "€": "EUR", "£": "GBP",
    "₹": "INR", "₩": "KRW", "฿": "THB", "₫": "VND", "₱": "PHP",
    "₺": "TRY", "₽": "RUB", "zł": "PLN", "元": "CNY", "円": "JPY",
  };
  const AMBIGUOUS = { "$": ["USD", "CAD", "AUD", "NZD", "HKD", "SGD", "TWD", "MXN"], "¥": ["CNY", "JPY"], "￥": ["CNY", "JPY"] };
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokens = [...Object.keys(CURRENCIES), ...Object.keys(SYMBOLS), ...Object.keys(AMBIGUOUS)].sort((a, b) => b.length - a.length).map(escape).join("|");
  const space = "[ \\t\\u00a0\\u202f]*";
  const number = "[+−-]?\\d(?:[\\d.,'’ \\u00a0\\u202f]*\\d)?";
  const cjk = "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]";
  const pattern = new RegExp(`(?:(?<![\\p{L}\\p{N}_])|(?<=${cjk}))(?:([+−-]?)(${tokens})${space}([$¥￥]?)${space}(${number})|(${number})${space}(${tokens}))(?:(?![\\p{L}\\p{N}_])|(?=${cjk}))`, "gu");

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
      const western = /^\d{1,3}$/.test(groups[0]) && groups.slice(1).every((g) => /^\d{3}$/.test(g));
      const indian = /^\d{1,2}$/.test(groups[0]) && /^\d{3}$/.test(groups.at(-1)) && groups.slice(1, -1).every((g) => /^\d{2}$/.test(g));
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
      jevEnabled: value.jevEnabled === true,
      // Store v0.1: the unaccepted reference-difference experiment cannot be enabled by old settings.
      jevSavingsEnabled: false,
      target: Object.hasOwn(CURRENCIES, value.target) ? value.target : DEFAULTS.target,
      provider: value.provider === "wise" ? "wise" : "ecb",
      sourceHint: Object.hasOwn(CURRENCIES, value.sourceHint) ? value.sourceHint : "",
      excludedHosts: Array.isArray(value.excludedHosts) ? value.excludedHosts.filter((s) => typeof s === "string" && /^[a-z0-9.:[\]-]+$/i.test(s)).slice(0, 200) : [],
    };
  }

  function convert(amount, source, table) {
    const rate = table?.rates?.[source]?.rate;
    // APIs return units of source currency per ONE unit of the user's target currency.
    return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? amount / rate : null;
  }

  function pairSavings(input, choice) {
    const pair = typeof choice === "string" && /^([A-D])_REFERENCE_([A-D])_CURRENT$/.exec(choice);
    if (!pair || pair[1] === pair[2] || !Array.isArray(input?.candidates) || input.candidates.length < 2 || input.candidates.length > 4) return null;
    const referenceIndex = pair[1].charCodeAt(0) - 65, currentIndex = pair[2].charCodeAt(0) - 65;
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

  function formatMoney(amount, currency) {
    return new Intl.NumberFormat("zh-CN", { style: "currency", currency, currencyDisplay: "code" }).format(amount);
  }

  const api = { CURRENCIES, ECB_CURRENCIES, DEFAULTS, currencyFor, parseAmount, findPrices, settingsFrom, convert, formatMoney, pairSavings };
  globalThis.PriceLens = Object.freeze(api);
  if (typeof module !== "undefined") module.exports = api;
})();
