/* Page-wide currency evidence: price-filter labels, metadata, JSON-LD and inline app data. Stateless per call. */
(() => {
  const C = PriceLens;
  const { SKIP, CARD, shown, isVisible } = PriceLensDom;

  function priceFilterHints() {
    const hints = [];
    for (const form of document.forms) {
      if (!isVisible(form) || !shown(form) || form.closest(CARD)) continue;
      let action;
      try { action = new URL(form.getAttribute("action") || location.href, document.baseURI); } catch { continue; }
      if (action.origin !== location.origin || action.pathname !== location.pathname) continue;
      const name = (input) => input.name.toLowerCase().replace(/[_-]/g, "");
      const bounds = [...form.querySelectorAll("input[name]")].filter((input) => ["text", "number", "range"].includes(input.type) && input.getClientRects().length && shown(input) && /^(?:(?:min|max)(?:price|p)|(?:price|p)(?:min|max))$/.test(name(input)));
      if (bounds.length !== 2) continue;
      const lower = bounds.find((input) => name(input).includes("min"));
      const upper = lower && bounds.find((input) => name(input) === name(lower).replace("min", "max"));
      if (!upper) continue;
      let group = lower.parentElement;
      while (group !== form && !group.contains(upper)) group = group.parentElement;
      // Only fixed, visible unit labels beside a same-page price filter; never input values or ad currency.
      const walker = document.createTreeWalker(group, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => node.parentElement.closest(`${SKIP},button`) || !isVisible(node.parentElement) || !shown(node.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      let node;
      while ((node = walker.nextNode())) {
        const currency = C.currencyFor(node.data.trim(), "");
        if (currency) hints.push(currency);
      }
    }
    return hints;
  }

  // Storefront-specific evidence, as data: each reader states where a site declares which currency it displays.
  // Everything else in this file reads generic markup, so an entry costs nothing on the pages it does not match and a
  // new site is one row here plus a fixture of its real markup, never a branch in the scan.
  // Add a row only when the site states its currency somewhere no generic rule can read it:
  // - A hostname-to-currency shortcut is deliberately absent. It would be a guess rather than evidence, and it is
  //   wrong exactly for the shopper who switched the site's currency - the shopper these readers exist to see. A shop
  //   that states nothing is served by the popup's per-site currency, which is offered whenever prices are skipped.
  // - `when` names the markup the site is known by, so an unrelated page carrying a same-named element cannot answer
  //   for it. `match` is a weaker hostname guard, for a selector that is not specific enough on its own.
  // - A reader reads what the page says, in the site's own words (an input's value, an element's text, an inline
  //   data code); it never decides what a currency symbol means, which stays with the ambiguous-mark rules.
  const SITE_READERS = [
    // Amazon: the hidden field holding the currency the shopper chose, and the nav data behind .a-price markup.
    { source: "selector", selector: 'input[type="hidden"][name="currencyOfPreference"]' },
    { source: "pattern", when: ".a-price > .a-offscreen", pattern: '"currencyInfo"\\s*:\\s*\\{\\s*"code"\\s*:\\s*"([A-Z]{3})"' },
  ];
  const SITE_SOURCES = {
    // What the site prints for the shopper: an input's value, otherwise the element's own text.
    selector: ({ selector }) => [...document.querySelectorAll(selector)].map((el) => (el.value ?? el.textContent).trim()),
    // A code out of the site's own inline data, captured by the reader's own pattern. Per call, so no shared lastIndex.
    pattern: ({ pattern }) => {
      const found = [];
      for (const script of document.scripts) for (const match of script.textContent.matchAll(new RegExp(pattern, "g"))) found.push(match[1]);
      return found;
    },
  };
  function siteHints() {
    const hints = [];
    for (const reader of SITE_READERS) {
      if (reader.when && !document.querySelector(reader.when)) continue;
      if (reader.match && !reader.match.test(location.hostname)) continue;
      hints.push(...SITE_SOURCES[reader.source](reader));
    }
    return hints;
  }
  // Every element selector the readers watch, so a change to one re-reads the page hint.
  const HINT_INPUTS = SITE_READERS.filter((reader) => reader.source === "selector").map((reader) => reader.selector).join(",");

  // Explicit display metadata only; never infer currency from a domain or language.
  function detectPageHint(jsonLd) {
    const hints = [document.documentElement.dataset.currency, ...priceFilterHints(), ...C.structuredCurrencies(jsonLd), ...siteHints()];
    for (const el of document.querySelectorAll('meta[property="product:price:currency"],meta[property="og:price:currency"],head meta[itemprop="priceCurrency"]')) hints.push(el.content);
    // Inline data may only narrow: any second declared code (a switcher, a display currency) cancels every page hint,
    // including metadata ones, and an unscannable script counts as possibly conflicting.
    const data = inlineDataCurrencies();
    if (!data) return "";
    // A visible currency switcher's selection is what the shopper sees; like inline data it can only veto.
    for (const select of document.querySelectorAll("select")) {
      const code = select.value.toUpperCase();
      if (/^[A-Z]{3}$/.test(code) && Object.hasOwn(C.CURRENCIES, code) && /currenc|货币|币种|通貨/i.test(`${select.name} ${select.id} ${select.getAttribute("aria-label") || ""} ${select.labels?.[0]?.textContent || ""}`)) data.all.add(code);
    }
    if (data.all.size > 1) return "";
    const meta = [...new Set(hints.filter((v) => Object.hasOwn(C.CURRENCIES, v)))];
    if (meta.length > 1) return "";
    const [declared] = data.all;
    if (meta.length) return !declared || declared === meta[0] ? meta[0] : "";
    // With no metadata, inline data is the only source and must tie that code to a price.
    return declared && data.positive.size === 1 && data.positive.has(declared) && Object.hasOwn(C.CURRENCIES, declared) ? declared : "";
  }

  // Stores that print only "$" often state the currency in their inline app data (Next.js, Redux, storefront config).
  // JSON-LD is excluded: it can list other regions' offers and is read through structuredCurrencies instead.
  const scriptCodes = new WeakMap();

  function inlineDataCurrencies() {
    const all = new Set(), positive = new Set();
    for (const script of document.scripts) {
      if (script.src || /^application\/ld\+json\b/i.test(script.type)) continue;
      const text = script.textContent;
      if (text.length > 5_000_000) return null; // An unscanned script may contain conflicts; fail closed.
      let cached = scriptCodes.get(script);
      if (cached?.text !== text) scriptCodes.set(script, cached = { text, codes: C.dataCurrencies(text) });
      for (const code of cached.codes.all) all.add(code);
      for (const code of cached.codes.positive) positive.add(code);
    }
    return { all, positive };
  }

  function readJsonLd() {
    const roots = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      if (script.textContent.length > 500_000) continue;
      try { roots.push(JSON.parse(script.textContent)); } catch { /* Malformed page JSON is not evidence. */ }
    }
    return roots;
  }

  globalThis.PriceLensEvidence = Object.freeze({ HINT_INPUTS, detectPageHint, readJsonLd });
})();
