(() => {
  const C = PriceLens;
  const { MARK, SKIP, CARD, CURRENCY_SCOPE, HEADING, CONTROL, holds, related, touchesAny, elementOf, shown, redact, composedOrder, textOf, visuallyClipped, isVisible, sourceRect, superscriptText, crossesProducts, isStruck } = PriceLensDom;
  const { PREFERENCE_INPUT, detectPageHint, readJsonLd } = PriceLensEvidence;
  const { colorCache, backgroundTheme, fits, layoutKey, placeBadge } = PriceLensPlacement;
  const records = new Map();
  const badgeAnchors = new WeakMap();
  const savingsRecords = new Map();
  const priceUnits = new Map();
  const skipped = new Map(); // Visible price unit -> one symbol ("$" or "¥") per price that no page evidence resolved.
  const pending = new Set();
  const visibilityRoots = new Set();
  const themeRoots = new Set();
  const visibilityTargets = new Map();
  const blockedPlacements = new Map();
  let hintDirty = true;
  let settings = C.DEFAULTS;
  let table = null;
  let pageHint = "";
  let structuredPairs = new Set();
  let timer;
  let scanning = false;
  let revision = 0;
  let refreshId = 0;
  let refreshing = 0;
  let hintCache = new WeakMap();
  const aiMemo = new Map();
  const aiScopes = new Set();
  let aiBusy = false;
  let aiEpoch = 0;
  let detailDialog = null;
  let detailBadge = null;

  // Open shadow roots: scanned like the document once the badge stylesheet can be adopted into them.
  const shadowRoots = new Set();
  let shadowSheet; // undefined: not loaded yet; null: unavailable, so shadow roots are left alone.
  function loadShadowSheet() {
    if (shadowSheet !== undefined) return;
    // The worker reads its own stylesheet, so content.css need not be web-accessible (and probeable by pages).
    shadowSheet = chrome.runtime.sendMessage({ type: "getStyles" }).then((result) => {
      if (!result?.ok || typeof result.css !== "string") throw new Error("styles unavailable");
      const css = result.css;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadowSheet = sheet;
      for (const root of shadowRoots) adoptSheet(root);
      if (shadowRoots.size) queue(document.body);
    }, () => { shadowSheet = null; });
  }
  function adoptSheet(root) {
    if (shadowSheet instanceof CSSStyleSheet && !root.adoptedStyleSheets.includes(shadowSheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, shadowSheet];
  }
  function enterShadow(host) {
    const root = host.shadowRoot;
    if (!root) return null;
    if (!shadowRoots.has(root)) {
      shadowRoots.add(root);
      observer.observe(root, OBSERVE);
      loadShadowSheet();
    }
    if (!(shadowSheet instanceof CSSStyleSheet)) return null;
    adoptSheet(root);
    return root;
  }

  function focusableBadges() {
    const badges = [document, ...shadowRoots].flatMap((root) => [...root.querySelectorAll('button.pricelens-price[data-pricelens]')]).filter((badge) => badgeAnchors.has(badge));
    return shadowRoots.size ? badges.sort(composedOrder) : badges;
  }

  function updateTabStops(preferred) {
    const badges = focusableBadges();
    const current = preferred || badges.find((badge) => badge.tabIndex === 0) || badges[0];
    for (const badge of badges) if (badge.tabIndex !== (badge === current ? 0 : -1)) badge.tabIndex = badge === current ? 0 : -1;
  }

  function closeDetails(restoreFocus = true) {
    const dialog = detailDialog, badge = detailBadge;
    detailDialog = null;
    detailBadge = null;
    dialog?.close();
    dialog?.remove();
    if (restoreFocus && badge?.isConnected) badge.focus();
  }

  // badge is null for a right-click selection result, which has no badge to return focus to.
  function showDetails(badge, body = badge.title) {
    if (detailDialog) return;
    if (badge) updateTabStops(badge);
    const dialog = document.createElement('dialog');
    dialog.className = 'pricelens-details';
    dialog.setAttribute(MARK, '');
    dialog.setAttribute('aria-label', C.t('detailsTitle'));
    if (badge) dialog.dataset.pricelensTheme = badge.dataset.pricelensTheme;
    const heading = document.createElement('h2');
    heading.textContent = C.t('detailsTitle');
    const text = document.createElement('p');
    text.textContent = body;
    const close = document.createElement('button');
    close.type = 'button';
    close.autofocus = true;
    close.textContent = C.t('close');
    close.addEventListener('click', () => closeDetails());
    dialog.append(heading, text, close);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDetails(); });
    dialog.addEventListener('close', () => { if (detailDialog === dialog) closeDetails(); });
    detailDialog = dialog;
    detailBadge = badge;
    document.body.append(dialog);
    if (!badge) dialog.dataset.pricelensTheme = backgroundTheme(dialog); // Page body colors, sampled from the dialog's parent.
    dialog.showModal();
  }

  document.addEventListener('click', (event) => {
    // In-control labels are not buttons: their click belongs to the host link.
    const badge = event.composedPath()[0].closest?.('button.pricelens-price[data-pricelens]');
    if (!badge || !badgeAnchors.has(badge)) return;
    event.preventDefault();
    event.stopPropagation(); // An annotation inside a product link must not navigate the page.
    showDetails(badge);
  }, true);
  document.addEventListener('keydown', (event) => {
    const badge = event.composedPath()[0];
    if (!badgeAnchors.has(badge) || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const badges = focusableBadges();
    const delta = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? badges.length - 1 : (badges.indexOf(badge) + delta + badges.length) % badges.length;
    updateTabStops(badges[index]);
    badges[index].focus();
  }, true);

  function resetAI() { aiEpoch++; aiMemo.clear(); aiScopes.clear(); }

  function aiContext(anchor, original) {
    let el = elementOf(anchor);
    if (!el || el === document.body || el.closest(`${SKIP},form,[role="form"]`) || C.isSensitivePath(location.pathname + location.hash)) return null;
    let result = null;
    for (let depth = 0; depth <= 3; depth++) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (node.parentElement?.closest(`${SKIP},form,[role="form"]`)) return NodeFilter.FILTER_REJECT;
          // Keep a canonical accessible price, but not invisible neighboring policy text.
          const priceCopy = anchor.contains(node) && node.data.includes(original);
          return priceCopy || (isVisible(node) && shown(node.parentElement)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      let text = "", node;
      while ((node = walker.nextNode()) && text.length <= 360) text += node.data;
      // Send a complete small scope, never a cropped fragment that can lose a qualifier.
      if (text.length > 360) break;
      text = redact(text);
      if (!text.includes(original) || text.length > 360) break;
      result = { context: text, scope: el };
      const parent = el.parentElement;
      if (el.matches(CARD) || !parent || parent.matches("body,html,main") || parent.closest("form,[role='form']") || crossesProducts(parent, anchor)) break;
      el = parent;
    }
    return result;
  }

  function aiCurrency(anchor, price) {
    if (!settings.jevEnabled || price.original.length > 80) return null;
    const snippet = aiContext(anchor, price.original);
    if (!snippet) return null;
    const candidate = { original: price.original, context: snippet.context };
    const key = JSON.stringify(candidate);
    if (!aiMemo.has(key)) {
      // ponytail: cap model work at 32 distinct candidates per page/settings cycle, not every DOM mutation.
      if (aiMemo.size >= 32) return null;
      aiMemo.set(key, { candidate, possible: price.possibleCurrencies, currency: null, pending: true, sent: false, anchors: new Set() });
    }
    const entry = aiMemo.get(key);
    aiScopes.add(snippet.scope);
    if (entry.pending) entry.anchors.add(anchor);
    return entry.currency;
  }

  async function flushAI() {
    if (aiBusy || !settings.jevEnabled || !table) return;
    const entries = [...aiMemo.values()].filter((entry) => entry.pending && !entry.sent).slice(0, 8);
    if (!entries.length) return;
    const epoch = aiEpoch;
    aiBusy = true;
    entries.forEach((entry) => { entry.sent = true; });
    let decisions = [];
    try {
      const result = await chrome.runtime.sendMessage({ type: "inferJev", candidates: entries.map((entry) => entry.candidate) });
      if (result.ok && Array.isArray(result.decisions)) decisions = result.decisions;
    } catch { /* Network/model failure cannot stop deterministic local conversion. */ }
    finally {
      if (epoch === aiEpoch && settings.jevEnabled) {
        entries.forEach((entry, i) => {
          entry.pending = false;
          entry.currency = entry.possible.includes(decisions[i]) ? decisions[i] : null;
          if (entry.currency) for (const anchor of entry.anchors) queue(anchor);
          entry.anchors.clear();
        });
      }
      aiBusy = false;
      void flushAI();
    }
  }

  // Currency for one price: its own card's markup first (the page states it for this very product), then the user's
  // site/global choice, then the page-wide hint. A card that contradicts itself gets none, not the user's guess.
  function hintFor(node) {
    let el = node.parentElement;
    const scope = el?.closest(CURRENCY_SCOPE);
    // data-currency is cheap to read, so inside a card follow it all the way up to the card. Outside any card only the
    // price's near ancestors count: a site-wide wrapper's data-currency is usually the store default, not what is shown.
    for (let up = el, depth = 0; up && up !== document.body && (scope || depth < 4); up = up.parentElement, depth++) {
      const hint = up.getAttribute("data-currency");
      if (Object.hasOwn(C.CURRENCIES, hint)) return hint;
      if (up === scope) break;
    }
    for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
      if (el === document.body) break;
      if (!hintCache.has(el)) {
        const metadata = (!scope && crossesProducts(el, node) ? [] : [...el.querySelectorAll('[itemprop="priceCurrency"]')])
          .filter((m) => m.closest(CURRENCY_SCOPE) === scope)
          .map((m) => m.getAttribute("content") || m.textContent.trim());
        hintCache.set(el, [...new Set(metadata.filter((v) => Object.hasOwn(C.CURRENCIES, v)))]);
      }
      const unique = hintCache.get(el);
      if (unique.length === 1) return unique[0];
      if (unique.length > 1) return "";
      if (el === scope) break;
    }
    return C.manualHint(settings, location.hostname) || pageHint;
  }

  function removeRecord(anchor, store = records) {
    if (store === records) skipped.delete(anchor);
    const record = store.get(anchor);
    if (record) for (const badge of record.badges) {
      if (badge === detailBadge) closeDetails(false);
      badge.remove();
    }
    store.delete(anchor);
  }

  function clear() {
    if (detailBadge) closeDetails(false); // A right-click result (no badge) is not page state; leave it open.
    revision++;
    for (const store of [records, savingsRecords]) for (const anchor of store.keys()) removeRecord(anchor, store);
    skipped.clear();
    pending.clear();
    priceUnits.clear();
    visibilityRoots.clear();
    themeRoots.clear();
    visibilityTargets.clear();
    blockedPlacements.clear();
    lazy.disconnect();
    deferred.clear();
    clearTimeout(timer);
    timer = null;
  }

  // Each placement is measured after insertion, which forces a layout; only work near the viewport and
  // let the rest wait until the user scrolls toward it.
  const deferred = new Set();
  const lazy = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) { lazy.unobserve(entry.target); deferred.delete(entry.target); queue(entry.target); }
  }, { rootMargin: "100% 0px" });

  function later(anchor) {
    // ponytail: one viewport of margin above and below; widen it if fast scrolling shows late badges.
    const rect = sourceRect(anchor);
    if (rect.bottom >= -innerHeight && rect.top <= innerHeight * 2) return false;
    const target = elementOf(anchor);
    if (!deferred.has(target)) { deferred.add(target); lazy.observe(target); }
    return true;
  }

  function covered(node, seen) {
    for (let current = node; current; current = current.parentNode) if (seen.has(current)) return true;
    return false;
  }

  function visibleUnit(el, prices) {
    if (visuallyClipped(el)) {
      const digits = prices[0].original.replace(/\D/g, "");
      let wrapper = el.parentElement;
      for (let depth = 0; wrapper && wrapper !== document.body && depth < 2; depth++, wrapper = wrapper.parentElement) {
        // Class-name independent accessible-price + aria-hidden visual duplicate pattern.
        const mirrors = [...wrapper.querySelectorAll('[aria-hidden="true"]')];
        if (isVisible(wrapper) && mirrors.some((mirror) => !visuallyClipped(mirror) && getComputedStyle(mirror).visibility === "visible" && textOf(mirror, true, true).replace(/\D/g, "") === digits)) return { anchor: wrapper, prices };
      }
    }
    return { anchor: el, prices };
  }

  // With AI on, symbol-only amounts ("$", "¥") are units too (AI may settle them). With AI off they are not, but the
  // popup counts them exactly as AI would read them (same unit, visibility and lazy rules): `count` is that unit, for
  // counting only. One walk serves both, reading each ancestor's text once; only a text with such a symbol is parsed twice.
  function unitFor(node, hint) {
    const unresolved = settings.jevEnabled, symbol = /[$¥￥]/;
    // Read a canonical complete price; CSS-implied decimals without one remain unsupported.
    let el = node.parentElement, count = null;
    for (let depth = 0; el && el !== document.body && depth < 3; depth++, el = el.parentElement) {
      if (el.matches(SKIP)) break;
      const clipped = visuallyClipped(el);
      const raw = el.querySelector("sup,sub") ? superscriptText(el) : textOf(el, !clipped);
      if (raw === null) break;
      const text = raw.trim();
      if (text.length > 100) break;
      const whole = (prices) => prices.length === 1 && ((prices[0].start === 0 && prices[0].end === text.length) || clipped);
      const prices = C.findPrices(text, hint, unresolved);
      if (whole(prices)) return visibleUnit(el, prices);
      if (!unresolved && !count && symbol.test(text)) {
        const all = C.findPrices(text, hint, true);
        if (whole(all)) count = visibleUnit(el, all);
      }
    }
    // "USD 19" directly followed by a superscript that is not accepted above is a truncated amount, not USD 19.
    const next = node.nextSibling;
    if (/\d\s*$/.test(node.data) && next?.nodeType === Node.ELEMENT_NODE && next.matches("sup,sub") && /^\s*\d/.test(next.textContent)) return { anchor: node, prices: [], count };
    const prices = C.findPrices(node.data, hint, unresolved);
    if (!prices.length && !unresolved && !count && symbol.test(node.data)) count = { anchor: node, prices: C.findPrices(node.data, hint, true) };
    return { anchor: node, prices, count };
  }

  function updateTheme(badge) {
    const theme = backgroundTheme(badge);
    if (badge.dataset.pricelensTheme !== theme) badge.dataset.pricelensTheme = theme;
    if (badge === detailBadge) detailDialog.dataset.pricelensTheme = theme;
  }

  function queueAppearance(root = document.documentElement) {
    if (!table || !root?.isConnected) return;
    themeRoots.add(root);
    visibilityRoots.add(root);
    hintDirty = true; // Price-filter unit evidence must follow CSS visibility, not just its initial state.
    queueAIContexts(root);
    schedule();
  }

  function annotate(node, seen, unitsSeen) {
    const parent = node.parentElement;
    if (!node.isConnected || !parent || parent.closest(SKIP) || covered(node, seen) || !node.data.trim() || node.data.length > 5000) return;
    const hint = hintFor(node);
    let { anchor, prices, count } = unitFor(node, hint);
    if (prices.length) { priceUnits.set(anchor, { node, prices, struck: settings.savingsEnabled ? prices.map((price) => isStruck(anchor, price)) : [] }); unitsSeen.add(anchor); }
    // Without AI a symbol-only amount is no price unit; renderPrices only counts it for the popup's site-currency hint.
    else if (count) ({ anchor, prices } = count);
    if (covered(anchor, seen)) return;
    const visible = isVisible(anchor);
    if (prices.length) visibilityTargets.set(anchor, visible);
    if (!visible) return;
    seen.add(anchor);
    if (!records.has(anchor) && later(anchor)) return;
    renderPrices(anchor, prices);
  }

  // Only "$", "¥" and "￥" stay unresolved; "￥" and a starting-price "～" are no different symbol to the user.
  const symbolOf = (price) => /[¥￥]/.test(price.original) ? "¥" : "$";
  // label: a non-interactive span for inside a host control; otherwise a button that opens the details dialog.
  function makeBadge(label) {
    const badge = document.createElement(label ? "span" : "button");
    badge.setAttribute(MARK, "");
    badge.className = "pricelens-price";
    if (!label) {
      badge.type = "button";
      badge.tabIndex = -1;
      badge.setAttribute("aria-haspopup", "dialog");
    }
    return badge;
  }
  function dropBadge(badge) {
    if (!badge) return;
    if (badge === detailBadge) closeDetails(false);
    badge.remove();
  }

  function renderPrices(anchor, prices, store = records, key = anchor) {
    const record = store.get(key);
    const old = record?.badges || [];
    const badges = [];
    const positions = [];
    let blocked = false;
    const ambiguous = [];
    let previous = store === savingsRecords ? records.get(anchor)?.badges.at(-1) || anchor : anchor;
    for (const candidate of prices) {
      const price = { ...candidate };
      const ai = !price.currency;
      if (ai) price.currency = aiCurrency(anchor, price);
      if (!price.currency) {
        // Symbol only ("$", "¥"), with AI off or unsettled by it: the popup offers this site's currency for these.
        if (store === records) ambiguous.push(symbolOf(price));
        continue;
      }
      if (price.currency === settings.target && !price.savings) continue;
      const amount = price.currency === settings.target ? price.amount : C.convert(price.amount, price.currency, table, settings.feePercent);
      if (amount === null || !Number.isFinite(amount)) continue;
      // A price inside a host link/button first tries a details button outside that control. If that cannot fit, a
      // plain label goes inside it: a control may not contain another control, and a click keeps opening the product.
      // Once a label, it stays one while the price stays inside a control, so re-renders do not retry failed spots.
      const reused = old[badges.length];
      const control = Boolean(elementOf(anchor)?.closest(CONTROL));
      let badge = reused && (control || reused.tagName !== "SPAN") ? reused : makeBadge(false);
      if (badge !== reused) dropBadge(reused);
      badgeAnchors.set(badge, anchor);
      const stale = price.currency !== settings.target && table.stale;
      const label = `${price.savings ? ` ${C.t("badgeSavings")} ` : " ≈ "}${C.formatMoney(amount, settings.target)}${price.minimum ? ` ${C.t("badgeFrom")}` : ""}${ai ? " · AI" : ""}${stale ? ` · ${C.t("badgeCache")}` : ""}`;
      const rate = table.rates[price.currency];
      const source = C.t({ wise: "sourceWise", blend: "sourceBlend" }[rate?.source ?? table.provider] ?? "sourceEcb");
      const basis = price.savings ? C.t("basisSavings", C.formatMoney(price.savings.reference.amount, price.currency), C.formatMoney(price.savings.current.amount, price.currency), C.formatMoney(price.amount, price.currency)) : `${price.original} (${price.currency})`;
      const quote = price.currency === settings.target ? C.t("quoteSameCurrency") : C.t("quoteTimes", source, rate.asOf, new Date(table.fetchedAt).toLocaleString(C.uiLocale()));
      const fee = price.currency !== settings.target && settings.feePercent ? `${C.t("feeIncluded", settings.feePercent)}\n` : "";
      let title = `${basis} → ${C.formatMoney(amount, settings.target)}\n${quote}\n${fee}${stale ? `${C.t("staleWarning", table.warning)}\n` : ""}${C.t(fee ? "disclaimerFee" : "disclaimer")}`;
      if (price.minimum) title += `\n${C.t("minimumNote")}`;
      if (price.savings) title += `\n${C.t("savingsNote", C.t(price.savings.source === "structured" ? "savingsStructured" : "savingsStrike"))}`;
      else if (ai) title += `\n${C.t("aiCurrencyNote", price.currency)}`;
      const dress = (el) => {
        if (el.dataset.stale !== String(stale)) el.dataset.stale = String(stale);
        if (el.dataset.pricelensSavings !== String(Boolean(price.savings))) el.dataset.pricelensSavings = String(Boolean(price.savings));
        if (el.textContent !== label) el.textContent = label;
        if (el.title === title) return;
        el.title = title;
        // A label's text is already part of its host control's accessible name; only the button needs its own.
        if (el.tagName === "BUTTON") el.setAttribute("aria-label", C.t("badgeAria", label.trim()));
        if (el === detailBadge) detailDialog.querySelector('p').textContent = title;
      };
      dress(badge);
      const position = record?.positions[badges.length];
      const nearby = position?.isConnected && (position === anchor || position === previous || position.contains(anchor)) && badge.parentNode === position.parentNode;
      let placed = placeBadge(anchor, badge, previous, nearby ? position : null, badgeAnchors);
      if (!placed && control && badge.tagName === "BUTTON") {
        dropBadge(badge);
        badge = makeBadge(true);
        badgeAnchors.set(badge, anchor);
        dress(badge);
        placed = placeBadge(anchor, badge, previous, null, badgeAnchors);
      }
      if (!placed) { dropBadge(badge); blocked = true; continue; }
      if (!nearby || placed !== position || !badge.dataset.pricelensTheme) updateTheme(badge);
      previous = badge;
      positions.push(placed);
      badges.push(badge);
    }
    for (const badge of old) if (!badges.includes(badge)) dropBadge(badge);
    if (store === records) {
      if (ambiguous.length) skipped.set(anchor, ambiguous);
      else skipped.delete(anchor);
    }
    if (badges.length) store.set(key, { badges, positions, anchor, layout: layoutKey(anchor) });
    else store.delete(key);
    if (store === records) {
      if (blocked) blockedPlacements.set(anchor, layoutKey(anchor));
      else blockedPlacements.delete(anchor);
    }
  }

  // Distinct amounts contained by each ancestor of a price unit, built once per scan (linear in units × depth).
  function amountIndex() {
    const index = new Map();
    for (const [unit, { prices }] of priceUnits) {
      for (let el = elementOf(unit); el && el !== document.body; el = el.parentElement) {
        if (!index.has(el)) index.set(el, new Set());
        for (const price of prices) index.get(el).add(`${price.currency}:${price.amount}`);
      }
    }
    return index;
  }

  let headed = new WeakMap(); // Per scan: a product list parent has thousands of children; check them once, not per price.
  const hasHeadingChild = (el) => {
    if (!headed.has(el)) headed.set(el, [...el.children].some((child) => child.matches(HEADING)));
    return headed.get(el);
  };

  function savingsScope(anchor, index) {
    let el = anchor.parentElement;
    for (let depth = 0; el && !el.matches("body,html,main") && depth < 4; depth++, el = el.parentElement) {
      if (el.closest(`${SKIP},form,[role='form']`) || crossesProducts(el, anchor)) return null;
      if (index.get(el)?.size >= 2) {
        // Include a containing card's heading/conditions, but do not expand into a product list.
        const parent = el.parentElement;
        if (parent && !parent.matches("body,html,main") && (parent.matches(CARD) || hasHeadingChild(parent)) && !crossesProducts(parent, anchor)) return parent;
        return el;
      }
      if (el.matches(CARD)) return null;
    }
    return null;
  }

  function savingsCandidate(scope) {
    const visible = isVisible(scope);
    visibilityTargets.set(scope, visible);
    if (!visible || scope.closest(`${SKIP},form,[role='form']`) || crossesProducts(scope, scope)) return null;
    if ([...scope.querySelectorAll("sup,sub")].some((el) => !el.closest('[aria-hidden="true"]'))) return null;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.parentElement?.closest(`${SKIP},form,[role='form']`) || !node.parentElement?.getClientRects().length || getComputedStyle(node.parentElement).visibility !== "visible" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let text = "", node, previousBlock;
    while ((node = walker.nextNode())) {
      const block = node.parentElement.closest("p,div,section,article,li,td");
      if (previousBlock && block !== previousBlock) text += " ";
      text += node.data.replace(/\s+/g, " ");
      previousBlock = block;
      // Do not truncate away membership/tax qualifiers to make a pair look unconditional.
      if (text.length > 360) return null;
    }
    const unique = new Map();
    for (const [unit, source] of priceUnits) {
      if (!scope.contains(unit) || source.node.parentElement?.closest(`${SKIP},form,[role='form']`) || !source.node.parentElement?.getClientRects().length) continue;
      for (const price of source.prices) {
        if (price.minimum || !price.currency || price.amount <= 0 || price.original.length > 80 || !text.includes(price.original)) return null;
        const id = `${price.currency}:${price.amount}`;
        if (!unique.has(id)) {
          let anchor = unit;
          while (anchor && anchor !== scope && !isVisible(anchor)) anchor = anchor.parentElement;
          if (!anchor || anchor === scope || !isVisible(anchor)) return null;
          unique.set(id, { price, anchor, struck: isStruck(unit, price) });
        }
      }
    }
    const values = [...unique.values()];
    if (values.length < 2 || values.length > 4) return null;
    const context = redact(text);
    if (context.length > 360 || values.some(({ price }) => !context.includes(price.original))) return null;
    for (const { anchor } of values) visibilityTargets.set(anchor, isVisible(anchor));
    return { anchors: values.map((value) => value.anchor), candidate: { context, currencyHint: values[0].price.currency, candidates: values.map(({ price, struck }) => ({ original: price.original, group: "item", struck })) } };
  }

  function scanSavings(roots) {
    const active = settings.savingsEnabled && !C.isSensitivePath(location.pathname + location.hash);
    for (const scope of savingsRecords.keys()) if (!scope.isConnected || !active) removeRecord(scope, savingsRecords);
    if (!active) return;
    const scopes = new Set();
    let index;
    headed = new WeakMap();
    for (const scope of savingsRecords.keys()) if (touchesAny(roots, scope)) scopes.add(scope);
    for (const anchor of priceUnits.keys()) {
      if (!touchesAny(roots, anchor)) continue;
      const scope = savingsScope(anchor, index ??= amountIndex());
      if (scope) scopes.add(scope);
    }
    const groups = [...scopes].filter((scope) => ![...scopes].some((outer) => outer !== scope && holds(outer, scope)));
    for (const scope of scopes) if (!groups.includes(scope)) removeRecord(scope, savingsRecords);
    for (const scope of groups) {
      if (!savingsRecords.has(scope) && later(scope)) continue;
      const prepared = savingsCandidate(scope);
      if (!prepared) { removeRecord(scope, savingsRecords); continue; }
      const savings = C.localSavings(prepared.candidate, structuredPairs);
      if (!savings) { removeRecord(scope, savingsRecords); continue; }
      renderPrices(prepared.anchors[savings.currentIndex], [{ ...savings, original: savings.current.original, savings }], savingsRecords, scope);
    }
  }

  function schedule() {
    // Bound the wait even on pages that continuously animate or mutate unrelated styles.
    if (timer) return;
    timer = setTimeout(() => { timer = null; void flush(); }, 120);
  }

  function queueAIContexts(root) {
    for (const scope of aiScopes) {
      if (!scope.isConnected) aiScopes.delete(scope);
      else if (related(scope, root)) pending.add(scope);
    }
    if (pending.size > 100) { pending.clear(); pending.add(document.body); }
  }

  function queue(root) {
    if (!table || !root?.isConnected) return;
    queueAIContexts(root);
    pending.add(root.nodeType === Node.TEXT_NODE ? root.parentElement : root); // A ShadowRoot stays itself.
    if (pending.size > 100) { pending.clear(); pending.add(document.body); }
    schedule();
  }

  async function flush() {
    if (scanning || !table) return;
    scanning = true;
    hintCache = new WeakMap();
    for (const root of shadowRoots) if (!root.isConnected) { shadowRoots.delete(root); }
    if (themeRoots.size) {
      colorCache.clear();
      for (const { badges } of [...records.values(), ...savingsRecords.values()]) for (const badge of badges) {
        if (badge.isConnected && [...themeRoots].some((root) => holds(root, badge))) updateTheme(badge);
      }
      themeRoots.clear();
    }
    if (hintDirty) {
      hintDirty = false;
      const jsonLd = readJsonLd();
      const hint = detectPageHint(jsonLd);
      if (hint !== pageHint) { pageHint = hint; pending.add(document.body); }
      const pairs = settings.savingsEnabled ? C.structuredSavings(jsonLd) : new Set();
      if ([...pairs].join() !== [...structuredPairs].join()) { structuredPairs = pairs; pending.add(document.body); }
    }
    for (const [anchor, visible] of visibilityTargets) {
      if (!anchor.isConnected) { visibilityTargets.delete(anchor); blockedPlacements.delete(anchor); continue; }
      if (touchesAny(visibilityRoots, anchor)) {
        const next = isVisible(anchor);
        const layout = blockedPlacements.get(anchor) ?? records.get(anchor)?.layout;
        const layoutChanged = layout !== undefined && layout !== layoutKey(anchor);
        if (next !== visible || layoutChanged || records.get(anchor)?.badges.some((badge) => badge.isConnected && !fits(badge))) pending.add(elementOf(anchor));
        visibilityTargets.set(anchor, next);
      }
    }
    if (settings.savingsEnabled) for (const [anchor, unit] of priceUnits) {
      if (anchor.isConnected && touchesAny(visibilityRoots, anchor) && unit.struck.some((struck, i) => struck !== isStruck(anchor, unit.prices[i]))) pending.add(elementOf(anchor));
    }
    for (const [scope, record] of savingsRecords) {
      if (!scope.isConnected) { removeRecord(scope, savingsRecords); continue; }
      if (touchesAny(visibilityRoots, scope) && (!isVisible(record.anchor) || record.badges.some((badge) => badge.isConnected && !fits(badge)))) pending.add(scope);
    }
    visibilityRoots.clear();
    const version = revision;
    const roots = [...pending].filter((root) => root?.isConnected);
    pending.clear();
    const topRoots = roots.filter((root) => !roots.some((other) => other !== root && holds(other, root)));
    // Skipped-price counts follow the same units as records: dropped once detached, hidden or no longer found.
    const affected = new Set();
    for (const store of [records, skipped]) for (const anchor of store.keys()) {
      if (!anchor.isConnected) removeRecord(anchor);
      else if (touchesAny(topRoots, anchor)) affected.add(anchor);
    }
    const seen = new Set(), unitsSeen = new Set();
    const affectedUnits = [];
    for (const anchor of priceUnits.keys()) {
      if (!anchor.isConnected) priceUnits.delete(anchor);
      else if (touchesAny(topRoots, anchor)) affectedUnits.push(anchor);
    }
    let visited = 0;
    try {
      const walkRoots = [...topRoots];
      for (const root of walkRoots) {
        if (root.closest?.(SKIP)) continue;
        // Elements are visited only to find open shadow roots, which are walked afterwards like any other root.
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
          acceptNode: (node) => node.nodeType === Node.ELEMENT_NODE ? (node.matches(SKIP) ? NodeFilter.FILTER_REJECT : node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP)
            : node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
        });
        let node;
        while ((node = walker.nextNode())) {
          if (version !== revision || !table) return;
          if (node.nodeType === Node.ELEMENT_NODE) { const shadow = enterShadow(node); if (shadow) walkRoots.push(shadow); continue; }
          annotate(node, seen, unitsSeen);
          if (++visited % 250 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      if (version === revision && table) {
        for (const anchor of affected) if (!seen.has(anchor)) removeRecord(anchor);
        for (const anchor of affectedUnits) if (!unitsSeen.has(anchor)) priceUnits.delete(anchor);
        scanSavings(topRoots);
      }
    } finally {
      scanning = false;
      updateTabStops();
      void flushAI();
      if (pending.size || visibilityRoots.size || themeRoots.size || hintDirty) schedule();
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (!table) return;
    for (const mutation of mutations) {
      // Pages that clone converted markup (carousels, virtual lists) copy our badges; drop copies we do not track.
      for (const node of mutation.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) {
        for (const badge of [node, ...node.querySelectorAll(".pricelens-price[data-pricelens]")]) if (badge.matches(".pricelens-price[data-pricelens]") && !badgeAnchors.has(badge)) badge.remove();
      }
      const element = elementOf(mutation.target);
      if (element?.closest(`[${MARK}]`)) continue;
      const changed = [...mutation.addedNodes, ...mutation.removedNodes];
      if (mutation.type === "childList" && changed.length && changed.every((n) => n.nodeType === Node.ELEMENT_NODE && n.hasAttribute(MARK))) continue;
      const touches = (sel) => element?.closest(sel) || changed.some((n) => n.nodeType === Node.ELEMENT_NODE && (n.matches(sel) || n.querySelector(sel)));
      if (touches("style,link[rel='stylesheet']")) queueAppearance();
      // Forms hold price-filter units; a currency <select> may sit outside any form.
      if (touches("form,select")) hintDirty = true;
      if (mutation.type === "attributes" && ["class", "style", "data-theme", "data-color-mode", "data-color-scheme", "data-bs-theme"].includes(mutation.attributeName)) {
        queueAppearance(element);
        continue;
      }
      if (mutation.type === "childList") themeRoots.add(element);
      if (touches(PREFERENCE_INPUT)) hintDirty = true;
      if (element?.closest("head,script") || mutation.attributeName === "content" || element === document.documentElement || changed.some((n) => n.nodeType === Node.ELEMENT_NODE && (n.matches("meta,script") || n.querySelector("meta,script")))) hintDirty = true;
      // Metadata constrains sibling prices, not merely its own (often empty) text subtree.
      if (mutation.attributeName === "itemprop" || touches('[itemprop="priceCurrency"]')) {
        queue(element?.closest(CURRENCY_SCOPE) || document.body);
      }
      queue(mutation.target);
    }
  });
  const OBSERVE = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["content", "itemprop", "data-currency", "hidden", "aria-hidden", "class", "style", "data-theme", "data-color-mode", "data-color-scheme", "data-bs-theme", "media", "disabled", "value", "name", "action", "type"] };
  observer.observe(document.documentElement, OBSERVE);

  async function refresh() {
    const id = ++refreshId;
    refreshing++; // Until the rescan is queued, pageStatus must not report the old counts as settled.
    try {
      const state = await chrome.runtime.sendMessage({ type: "getState" });
      if (id !== refreshId) return;
      if (!state.ok) throw new Error(state.error);
      const next = state.settings;
      const settingsChanged = JSON.stringify(next) !== JSON.stringify(settings);
      const routeChanged = next.target !== settings.target || next.provider !== settings.provider;
      settings = next;
      if (settingsChanged) { resetAI(); revision++; skipped.clear(); }
      if (routeChanged) { clear(); table = null; }
      if (!settings.enabled || settings.excludedHosts.includes(location.hostname)) { clear(); table = null; return; }
      const response = await chrome.runtime.sendMessage({ type: "getRates" });
      if (id !== refreshId) return;
      if (!response.ok) throw new Error(response.error);
      if (JSON.stringify(response.table) === JSON.stringify(table)) {
        if (settingsChanged) { hintDirty = true; queue(document.body); }
        return;
      }
      revision++;
      table = response.table;
      hintDirty = true;
      queue(document.body);
    } catch {
      if (id === refreshId) { clear(); table = null; }
      // Fail closed: never replace original prices or show invented conversion rates.
    } finally { refreshing--; }
  }

  chrome.storage.onChanged.addListener((_, area) => { if (area === "sync") refresh(); });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "pageStatus") {
      // Only symbols and counts leave this page, and only to this extension's popup.
      const symbols = new Set();
      let count = 0;
      for (const [anchor, marks] of skipped) if (anchor.isConnected) { count += marks.length; for (const mark of marks) symbols.add(mark); }
      // pending: a scan or AI answer is still due, so the popup asks again instead of showing a count about to change.
      const busy = refreshing > 0 || scanning || Boolean(timer) || [...aiMemo.values()].some((entry) => entry.pending);
      sendResponse({ ok: true, active: Boolean(table), skipped: count, symbols: [...symbols].sort(), pending: busy });
      return;
    }
    if (message?.type === "refresh") {
      if (message.resetJev) { resetAI(); revision++; queue(document.body); }
      refresh();
    }
    if (message?.type === "showConversion" && typeof message.text === "string" && document.body) {
      closeDetails(false);
      showDetails(null, message.text);
    }
  });
  window.addEventListener("resize", () => { queueAppearance(); queue(document.body); });
  // The event may change a page's CSS; the chosen palette still comes only from the actual background.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => queueAppearance());
  // A shopper picking another currency in a native <select> changes no DOM, so re-read the page hint on change too.
  document.addEventListener("change", () => { hintDirty = true; queueAppearance(); });
  document.addEventListener("load", (event) => { if (event.target.matches?.("link[rel='stylesheet']")) queueAppearance(); }, true);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { queueAppearance(); refresh(); } });
  setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60_000);
  refresh();
})();
