(() => {
  const C = PriceLens;
  const MARK = "data-pricelens";
  const SKIP = `script,style,noscript,textarea,input,select,option,code,pre,svg,math,canvas,iframe,sup,sub,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[hidden],[aria-hidden="true"],[${MARK}]`;
  const records = new Map();
  const badgeAnchors = new WeakMap();
  const savingsRecords = new Map();
  const priceUnits = new Map();
  const PRODUCT = '[itemscope][itemtype$="/Product"],[data-product-id],[data-asin]:not([data-asin=""])';
  const CARD = `${PRODUCT},article,li,[role='listitem']`;
  const HEADING = "h1,h2,h3,h4,h5,h6";
  const pending = new Set();
  const visibilityRoots = new Set();
  const themeRoots = new Set();
  const colorCache = new Map();
  let colorContext;
  const visibilityTargets = new Map();
  const blockedPlacements = new Map();
  let hintDirty = true;
  let settings = C.DEFAULTS;
  let table = null;
  let pageHint = "";
  let timer;
  let scanning = false;
  let revision = 0;
  let refreshId = 0;
  let hintCache = new WeakMap();
  const aiMemo = new Map();
  const aiScopes = new Set();
  let aiBusy = false;
  let aiEpoch = 0;

  function resetAI() { aiEpoch++; aiMemo.clear(); aiScopes.clear(); }

  function aiContext(anchor, original) {
    let el = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
    if (!el || el === document.body || el.closest(`${SKIP},form,[role="form"]`) || /(?:checkout|payment|account|login|orders?|cart)(?:[/.?_-]|$)/i.test(location.pathname)) return null;
    let result = null;
    for (let depth = 0; depth <= 3; depth++) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (node.parentElement?.closest(`${SKIP},form,[role="form"]`)) return NodeFilter.FILTER_REJECT;
          // Keep a canonical accessible price, but not invisible neighboring policy text.
          const priceCopy = anchor.contains(node) && node.data.includes(original);
          return priceCopy || (isVisible(node) && node.parentElement.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) !== false) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      let text = "", node;
      while ((node = walker.nextNode()) && text.length <= 360) text += node.data;
      // Send a complete small scope, never a cropped fragment that can lose a qualifier.
      if (text.length > 360) break;
      text = text.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[邮箱已移除]").replace(/\+?\d[\d ()-]{7,}\d/g, "[长数字已移除]");
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
    const waiting = [...aiMemo.values()].filter((entry) => entry.pending && !entry.sent);
    if (!waiting.length) return;
    const kind = waiting[0].type || "currency";
    const entries = waiting.filter((entry) => (entry.type || "currency") === kind).slice(0, 8);
    const epoch = aiEpoch;
    aiBusy = true;
    entries.forEach((entry) => { entry.sent = true; });
    let decisions = [];
    try {
      const result = await chrome.runtime.sendMessage({ type: kind === "savings" ? "inferJevSavings" : "inferJev", candidates: entries.map((entry) => entry.candidate) });
      if (result.ok && Array.isArray(result.decisions)) decisions = result.decisions;
    } catch { /* Network/model failure cannot stop deterministic local conversion. */ }
    finally {
      if (epoch === aiEpoch && settings.jevEnabled) {
        entries.forEach((entry, i) => {
          entry.pending = false;
          if (kind === "savings") entry.choice = C.pairSavings(entry.candidate, decisions[i]) ? decisions[i] : null;
          else entry.currency = entry.possible.includes(decisions[i]) ? decisions[i] : null;
          if (kind === "savings" || entry.currency) for (const anchor of entry.anchors) queue(anchor);
          entry.anchors.clear();
        });
      }
      aiBusy = false;
      void flushAI();
    }
  }

  function textOf(node, visibleOnly = false) {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (visibleOnly && (visuallyClipped(node) || getComputedStyle(node).visibility !== "visible")) return "";
    let text = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child.hasAttribute(MARK)) continue;
      text += textOf(child, visibleOnly);
      if (text.length > 160) break;
    }
    return text;
  }

  function priceFilterHints() {
    const hints = [];
    for (const form of document.forms) {
      if (!isVisible(form) || form.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === false || form.closest(CARD)) continue;
      let action;
      try { action = new URL(form.getAttribute("action") || location.href, document.baseURI); } catch { continue; }
      if (action.origin !== location.origin || action.pathname !== location.pathname) continue;
      const name = (input) => input.name.toLowerCase().replace(/[_-]/g, "");
      const bounds = [...form.querySelectorAll("input[name]")].filter((input) => ["text", "number", "range"].includes(input.type) && input.getClientRects().length && input.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) !== false && /^(?:(?:min|max)(?:price|p)|(?:price|p)(?:min|max))$/.test(name(input)));
      if (bounds.length !== 2) continue;
      const lower = bounds.find((input) => name(input).includes("min"));
      const upper = lower && bounds.find((input) => name(input) === name(lower).replace("min", "max"));
      if (!upper) continue;
      let group = lower.parentElement;
      while (group !== form && !group.contains(upper)) group = group.parentElement;
      // Only fixed, visible unit labels beside a same-page price filter; never input values or ad currency.
      const walker = document.createTreeWalker(group, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => node.parentElement.closest(`${SKIP},button`) || !isVisible(node.parentElement) || node.parentElement.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === false ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      let node;
      while ((node = walker.nextNode())) {
        const currency = C.currencyFor(node.data.trim(), "");
        if (currency) hints.push(currency);
      }
    }
    return hints;
  }

  function detectPageHint() {
    const hints = [document.documentElement.dataset.currency, ...priceFilterHints()];
    // Explicit display preference metadata; never infer currency from a domain or language.
    for (const el of document.querySelectorAll('input[type="hidden"][name="currencyOfPreference"]')) hints.push(el.value);
    for (const el of document.querySelectorAll('meta[property="product:price:currency"],meta[property="og:price:currency"],head meta[itemprop="priceCurrency"]')) hints.push(el.content);
    // An explicit page currency is navigation data, not a guess from domain or language.
    if (document.querySelector(".a-price > .a-offscreen")) {
      for (const script of document.scripts) {
        for (const match of script.textContent.matchAll(/"currencyInfo"\s*:\s*\{\s*"code"\s*:\s*"([A-Z]{3})"/g)) hints.push(match[1]);
      }
    }
    const unique = [...new Set(hints.filter((v) => Object.hasOwn(C.CURRENCIES, v)))];
    return unique.length === 1 ? unique[0] : "";
  }

  function hintFor(node) {
    if (settings.sourceHint) return settings.sourceHint;
    let el = node.parentElement;
    for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
      const hint = el.getAttribute("data-currency");
      if (Object.hasOwn(C.CURRENCIES, hint)) return hint;
      if (el === document.body) break;
      if (!hintCache.has(el)) {
        const metadata = [...el.querySelectorAll('[itemprop="priceCurrency"]')].map((m) => m.getAttribute("content") || m.textContent.trim());
        hintCache.set(el, [...new Set(metadata.filter((v) => Object.hasOwn(C.CURRENCIES, v)))]);
      }
      const unique = hintCache.get(el);
      if (unique.length === 1) return unique[0];
      if (unique.length > 1) return "";
    }
    return pageHint;
  }

  function removeRecord(anchor, store = records) {
    const record = store.get(anchor);
    if (record) for (const badge of record.badges) badge.remove();
    store.delete(anchor);
  }

  function clear() {
    revision++;
    for (const store of [records, savingsRecords]) for (const anchor of store.keys()) removeRecord(anchor, store);
    pending.clear();
    priceUnits.clear();
    visibilityRoots.clear();
    themeRoots.clear();
    visibilityTargets.clear();
    blockedPlacements.clear();
    clearTimeout(timer);
    timer = null;
  }

  function covered(node, seen) {
    for (let current = node; current; current = current.parentNode) if (seen.has(current)) return true;
    return false;
  }

  function visuallyClipped(el) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    // Offscreen accessibility labels can retain a normal text size without a clip rectangle.
    const offscreen = style.position === "absolute" && (parseFloat(style.left) < -1000 || parseFloat(style.top) < -1000);
    return Number(style.opacity) === 0 || offscreen || (rect.width <= 1 && rect.height <= 1) || !["auto", "none"].includes(style.clip) || style.clipPath !== "none";
  }

  function isVisible(anchor) {
    const el = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
    return Boolean(el?.isConnected && !el.closest(SKIP) && !visuallyClipped(el) && [...el.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0) && getComputedStyle(el).visibility === "visible");
  }

  function visibleUnit(el, prices) {
    if (visuallyClipped(el)) {
      const digits = prices[0].original.replace(/\D/g, "");
      let wrapper = el.parentElement;
      for (let depth = 0; wrapper && wrapper !== document.body && depth < 2; depth++, wrapper = wrapper.parentElement) {
        // Class-name independent accessible-price + aria-hidden visual duplicate pattern.
        const mirrors = [...wrapper.querySelectorAll('[aria-hidden="true"]')];
        if (isVisible(wrapper) && mirrors.some((mirror) => !visuallyClipped(mirror) && getComputedStyle(mirror).visibility === "visible" && textOf(mirror, true).replace(/\D/g, "") === digits)) return { anchor: wrapper, prices };
      }
    }
    return { anchor: el, prices };
  }

  function unitFor(node, hint) {
    // Read a canonical complete price; CSS-implied decimals without one remain unsupported.
    let el = node.parentElement;
    for (let depth = 0; el && el !== document.body && depth < 3; depth++, el = el.parentElement) {
      if (el.matches(SKIP) || el.querySelector("sup,sub")) break;
      const text = textOf(el).trim();
      if (text.length > 100) break;
      const prices = C.findPrices(text, hint, settings.jevEnabled);
      if (prices.length === 1 && ((prices[0].start === 0 && prices[0].end === text.length) || visuallyClipped(el))) return visibleUnit(el, prices);
    }
    return { anchor: node, prices: C.findPrices(node.data, hint, settings.jevEnabled) };
  }

  function sourceRect(anchor) {
    if (anchor.nodeType === Node.ELEMENT_NODE) return anchor.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(anchor);
    return range.getBoundingClientRect();
  }

  function backgroundTheme(badge) {
    try {
      let remaining = 1;
      const color = [0, 0, 0];
      for (let el = badge.parentElement; el && remaining > 0; el = el.parentElement) {
        const style = getComputedStyle(el);
        // Images/gradients cannot be reliably sampled from CSS. Use a solid, high-contrast fallback.
        if (style.backgroundImage !== "none") return "light";
        const value = style.backgroundColor;
        if (!colorCache.has(value)) {
          if (!colorContext) {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            colorContext = canvas.getContext("2d", { willReadFrequently: true });
          }
          colorContext.clearRect(0, 0, 1, 1);
          colorContext.fillStyle = value;
          colorContext.fillRect(0, 0, 1, 1);
          colorCache.set(value, colorContext.getImageData(0, 0, 1, 1).data);
          if (colorCache.size > 256) colorCache.delete(colorCache.keys().next().value);
        }
        const rgba = colorCache.get(value);
        const alpha = rgba[3] / 255;
        for (let i = 0; i < 3; i++) color[i] += rgba[i] * alpha * remaining;
        remaining *= 1 - alpha;
      }
      // A page can explicitly request a dark default canvas without painting a background.
      const scheme = getComputedStyle(document.documentElement).colorScheme;
      const canvasColor = scheme.includes("dark") && !scheme.includes("light") ? 18 : 255;
      const linear = color.map((channel) => {
        const value = (channel + remaining * canvasColor) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 < 0.18 ? "dark" : "light";
    } catch { return "light"; }
  }

  function updateTheme(badge) {
    const theme = backgroundTheme(badge);
    if (badge.dataset.pricelensTheme !== theme) badge.dataset.pricelensTheme = theme;
  }

  function queueAppearance(root = document.documentElement) {
    if (!table || !root?.isConnected) return;
    themeRoots.add(root);
    visibilityRoots.add(root);
    hintDirty = true; // Price-filter unit evidence must follow CSS visibility, not just its initial state.
    queueAIContexts(root);
    schedule();
  }

  function fits(badge) {
    const rect = badge.getBoundingClientRect();
    if (!rect.width || !rect.height || getComputedStyle(badge).visibility !== "visible") return false;
    for (let el = badge.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (style.clipPath !== "none" || !["auto", "none"].includes(style.clip) || !["none", "0", ""].includes(style.webkitLineClamp)) return false;
      if (["hidden", "clip"].includes(style.overflowX) && (rect.left < box.left - 1 || rect.right > box.right + 1)) return false;
      if (["hidden", "clip"].includes(style.overflowY) && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1)) return false;
    }
    return true;
  }

  function layoutKey(anchor) {
    const parts = [];
    let el = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
    for (let depth = 0; el && el !== document.body && depth < 5; depth++, el = el.parentElement) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      parts.push([rect.width, rect.height, style.display, style.position, style.overflowX, style.overflowY, style.maxWidth, style.maxHeight, style.clip, style.clipPath, style.webkitLineClamp, style.font, style.whiteSpace, style.textAlign, style.flexDirection, style.gridTemplateColumns].join("/"));
    }
    return parts.join("|");
  }

  function flowSnapshot(anchor) {
    let scope = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
    while (scope && scope !== document.body && ["inline", "inline-block", "contents"].includes(getComputedStyle(scope).display)) scope = scope.parentElement;
    if (!scope || scope === document.body || scope === document.documentElement) return null;
    const lines = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.data.trim() || node.parentElement.closest(`[${MARK}],script,style,[hidden]`) || visuallyClipped(node.parentElement) || getComputedStyle(node.parentElement).visibility !== "visible") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect) => rect.width && rect.height);
      if (rects.length) lines.push({ range, rects });
    }
    return { scope, box: scope.getBoundingClientRect(), lines };
  }

  function preservesFlow(snapshot, badge, scrollbarDelta) {
    if (!snapshot) return true;
    const { scope, box, lines } = snapshot;
    const next = scope.getBoundingClientRect(), badgeBox = badge.getBoundingClientRect();
    const inside = scope.contains(badge);
    if (Math.abs(next.width - box.width) > scrollbarDelta + 1 || Math.abs(next.height - box.height) > (inside ? badgeBox.height : 1)) return false;
    let shift, sharesLine = false;
    for (const { range, rects } of lines) {
      const current = [...range.getClientRects()].filter((rect) => rect.width && rect.height);
      if (current.length !== rects.length) return false;
      for (let i = 0; i < rects.length; i++) {
        shift ??= current[i].top - rects[i].top;
        if (Math.min(current[i].bottom, badgeBox.bottom) - Math.max(current[i].top, badgeBox.top) > Math.min(current[i].height, badgeBox.height) / 2) sharesLine = true;
        if (Math.abs(current[i].width - rects[i].width) > 1 || Math.abs(current[i].height - rects[i].height) > 1 || Math.abs(current[i].top - rects[i].top - shift) > 1) return false;
      }
    }
    // Allow baseline growth on an existing line, not an extra line wedged into the original copy.
    return !inside || sharesLine;
  }

  function placeBadge(anchor, badge, previous, position) {
    // Measure original flow without this badge, including when reusing it after resize or price changes.
    if (badge.isConnected) badge.style.display = "none";
    const before = sourceRect(anchor);
    const flow = flowSnapshot(anchor);
    const viewportWidth = document.documentElement.clientWidth;
    badge.style.removeProperty("display");
    const safe = () => {
      const after = sourceRect(anchor);
      const scrollbarDelta = Math.abs(document.documentElement.clientWidth - viewportWidth);
      const parent = badge.parentElement;
      // A badge must not become another flex/grid item and squeeze prices or neighboring controls.
      if (/flex|grid/.test(getComputedStyle(parent).display)) return false;
      const neighborhood = flow?.scope.parentElement?.parentElement;
      if (neighborhood && neighborhood !== document.body && neighborhood !== document.documentElement) for (const other of neighborhood.querySelectorAll(`[${MARK}]`)) {
        const source = badgeAnchors.get(other);
        if (other === badge || !source || source === anchor) continue;
        // Lifting one price's badge must not reverse it with a nearby price's annotation.
        if (Boolean(source.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING) !== Boolean(other.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      }
      const rect = badge.getBoundingClientRect(), bounds = parent.getBoundingClientRect();
      return rect.left >= Math.max(0, bounds.left) - 1 && rect.right <= Math.min(document.documentElement.clientWidth, bounds.right) + 1 && fits(badge) && Math.abs(after.height - before.height) <= 1 && Math.abs(after.width - before.width) <= scrollbarDelta + 1 && preservesFlow(flow, badge, scrollbarDelta);
    };
    if (position && safe()) return position;
    badge.remove();
    let target = previous;
    if (previous === anchor) {
      let el = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
      const original = textOf(anchor).trim();
      for (let depth = 0; el && el !== document.body && depth < 3; depth++, el = el.parentElement) {
        if (textOf(el).trim() !== original) break;
        if (["absolute", "fixed"].includes(getComputedStyle(el).position)) { target = el.parentElement; break; }
      }
    }
    for (let depth = 0; target?.parentElement && target !== document.body && target !== document.documentElement && depth < 3; depth++, target = target.parentElement) {
      // Never write inside the price component. Try nearby flow containers only, not a page-wide overlay.
      const box = sourceRect(target);
      if (target !== anchor && target !== previous && ((box.width > Math.max(420, before.width * 4) && !(target === flow?.scope && textOf(target).length <= 360)) || box.height > Math.max(420, before.height * 12))) break;
      let insertion = target;
      for (let next = target.nextSibling; next?.nodeType === Node.ELEMENT_NODE && next.hasAttribute(MARK); next = next.nextSibling) {
        const source = badgeAnchors.get(next);
        if (next === badge || !source || !(source.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
        insertion = next;
      }
      insertion.after(badge);
      if (safe()) return target;
      badge.remove();
      // On fallback, step past inline wrappers to keep their words and price qualifiers together.
      while (target.parentElement && target.parentElement !== document.body && ["inline", "contents"].includes(getComputedStyle(target.parentElement).display)) target = target.parentElement;
    }
    return null;
  }

  function annotate(node, seen, unitsSeen) {
    const parent = node.parentElement;
    if (!node.isConnected || !parent || parent.closest(SKIP) || covered(node, seen) || !node.data.trim() || node.data.length > 5000) return;
    const { anchor, prices } = unitFor(node, hintFor(node));
    if (prices.length) { priceUnits.set(anchor, { node, prices, struck: settings.jevSavingsEnabled ? prices.map((price) => isStruck(anchor, price)) : [] }); unitsSeen.add(anchor); }
    if (covered(anchor, seen)) return;
    const visible = isVisible(anchor);
    if (prices.length) visibilityTargets.set(anchor, visible);
    if (!visible) return;
    seen.add(anchor);
    renderPrices(anchor, prices);
  }

  function renderPrices(anchor, prices, store = records, key = anchor) {
    const record = store.get(key);
    const old = record?.badges || [];
    const badges = [];
    const positions = [];
    let blocked = false;
    let previous = store === savingsRecords ? records.get(anchor)?.badges.at(-1) || anchor : anchor;
    for (const candidate of prices) {
      const price = { ...candidate };
      const ai = !price.currency;
      if (ai) price.currency = aiCurrency(anchor, price);
      if (!price.currency || (price.currency === settings.target && !price.savings)) continue;
      const amount = price.currency === settings.target ? price.amount : C.convert(price.amount, price.currency, table);
      if (amount === null || !Number.isFinite(amount)) continue;
      const badge = old[badges.length] || document.createElement("span");
      if (!badge.hasAttribute(MARK)) { badge.setAttribute(MARK, ""); badge.className = "pricelens-price"; }
      badgeAnchors.set(badge, anchor);
      const stale = price.currency !== settings.target && table.stale;
      if (badge.dataset.stale !== String(stale)) badge.dataset.stale = String(stale);
      if (badge.dataset.pricelensSavings !== String(Boolean(price.savings))) badge.dataset.pricelensSavings = String(Boolean(price.savings));
      const label = `${price.savings ? " 参考标价差约 " : " ≈ "}${C.formatMoney(amount, settings.target)}${price.minimum ? " 起" : ""}${ai || price.savings ? " · AI" : ""}${stale ? " · 缓存" : ""}`;
      if (badge.textContent !== label) badge.textContent = label;
      const rate = table.rates[price.currency];
      const source = table.provider === "wise" ? "Wise 中间价" : "ECB / Frankfurter 日更参考汇率（非实时）";
      const basis = price.savings ? `参考价 ${C.formatMoney(price.savings.reference.amount, price.currency)} − 现价 ${C.formatMoney(price.savings.current.amount, price.currency)} = ${C.formatMoney(price.amount, price.currency)}` : `${price.original} (${price.currency})`;
      const quote = price.currency === settings.target ? "本币差额，不涉及换汇。" : `${source}\n报价时间：${rate.asOf}\n获取时间：${new Date(table.fetchedAt).toLocaleString("zh-CN")}`;
      let title = `${basis} → ${C.formatMoney(amount, settings.target)}\n${quote}\n${stale ? `更新失败，使用旧缓存：${table.warning}\n` : ""}仅供参考，不含手续费；实际结算以商家/银行为准。`;
      if (price.minimum) title += "\n这是起价下限，不是固定售价或最终结算金额。";
      if (price.savings) title += "\n仅为页面所列参考价与现价的数字差，由本地计算；价格关系由 Jev 判断，可能有误。税费口径与购买资格未核实，不代表实际可省金额或最终结算优惠；参考价不等于历史成交价。";
      else if (ai) title += `\n币种 ${price.currency} 由 Jev 辅助推断，可能有误，请核对原页面。`;
      if (badge.title !== title) { badge.title = title; badge.setAttribute("aria-label", title); }
      const position = record?.positions[badges.length];
      const nearby = position?.isConnected && (position === anchor || position === previous || position.contains(anchor)) && badge.parentNode === position.parentNode;
      const placed = placeBadge(anchor, badge, previous, nearby ? position : null);
      if (!placed) { badge.remove(); blocked = true; continue; }
      if (!nearby || placed !== position || !badge.dataset.pricelensTheme) updateTheme(badge);
      previous = badge;
      positions.push(placed);
      badges.push(badge);
    }
    for (const badge of old.slice(badges.length)) badge.remove();
    if (badges.length) store.set(key, { badges, positions, anchor, layout: layoutKey(anchor) });
    else store.delete(key);
    if (store === records) {
      if (blocked) blockedPlacements.set(anchor, layoutKey(anchor));
      else blockedPlacements.delete(anchor);
    }
  }

  function isStruck(anchor, price) {
    const el = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
    const decorated = (node) => {
      for (let parent = node; parent && parent !== document.body; parent = parent.parentElement) {
        if (parent.matches("s,del") || getComputedStyle(parent).textDecorationLine.includes("line-through")) return true;
      }
      return false;
    };
    if (!el) return false;
    if (decorated(el)) return true;
    // A text anchor owns only that text, never the formatting of a sibling amount.
    if (anchor.nodeType === Node.TEXT_NODE) return false;
    for (const mirror of [el, ...el.querySelectorAll("*")]) {
      if (mirror.closest(`[${MARK}],script,style,[hidden],form`) || visuallyClipped(mirror) || getComputedStyle(mirror).visibility !== "visible") continue;
      const values = C.findPrices(textOf(mirror, true), price.currency);
      if (!values.length || !values.every((value) => value.currency === price.currency && value.amount === price.amount)) continue;
      if (decorated(mirror)) return true;
      if (getComputedStyle(mirror).position === "static") continue;
      // Some sites draw a strike with a thin, full-width pseudo-element across the price's middle.
      // Do not treat underlines, separators or a line on a different amount as strike evidence.
      const rect = mirror.getBoundingClientRect();
      for (const pseudo of ["::before", "::after"]) {
        const line = getComputedStyle(mirror, pseudo);
        const border = Math.max(parseFloat(line.borderTopWidth), parseFloat(line.borderBottomWidth));
        const top = parseFloat(line.top), width = parseFloat(line.width), left = parseFloat(line.left);
        if (line.content === '""' && line.position === "absolute" && line.visibility === "visible" && Number(line.opacity) > 0 && line.transform === "none" && border > 0 && border <= 2 && (parseFloat(line.height) || 0) <= 2 && Math.abs(left) <= 2 && width >= rect.width * 0.9 && width <= rect.width + 2 && top >= rect.height * 0.35 && top <= rect.height * 0.65) return true;
      }
    }
    return false;
  }

  function crossesProducts(scope, origin) {
    if (scope.querySelectorAll(HEADING).length > 1) return true;
    if ([...scope.querySelectorAll(CARD)].some((card) => !origin || !card.contains(origin))) return true;
    const links = [...scope.querySelectorAll("a[href]")].filter((link) => link.querySelector(`img,${HEADING}`));
    return new Set(links.map((link) => link.getAttribute("href"))).size > 1;
  }

  function savingsScope(anchor) {
    let el = anchor.parentElement;
    for (let depth = 0; el && !el.matches("body,html,main") && depth < 4; depth++, el = el.parentElement) {
      if (el.closest(`${SKIP},form,[role='form']`) || crossesProducts(el, anchor)) return null;
      const amounts = new Set();
      // ponytail: local-ancestor scans are quadratic in page price units; index by container if profiling warrants it.
      for (const [unit, { prices }] of priceUnits) if (el.contains(unit)) for (const price of prices) amounts.add(`${price.currency}:${price.amount}`);
      if (amounts.size >= 2) {
        // Include a containing card's heading/conditions, but do not expand into a product list.
        const parent = el.parentElement;
        if (parent && !parent.matches("body,html,main") && (parent.matches(CARD) || [...parent.children].some((child) => child.matches(HEADING))) && !crossesProducts(parent, anchor)) return parent;
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
    const context = text.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[邮箱已移除]").replace(/\+?\d[\d ()-]{7,}\d/g, "[长数字已移除]");
    if (context.length > 360 || values.some(({ price }) => !context.includes(price.original))) return null;
    for (const { anchor } of values) visibilityTargets.set(anchor, isVisible(anchor));
    return { anchors: values.map((value) => value.anchor), candidate: { context, currencyHint: values[0].price.currency, candidates: values.map(({ price, struck }) => ({ original: price.original, group: "item", struck })) } };
  }

  function scanSavings(roots) {
    for (const scope of savingsRecords.keys()) if (!scope.isConnected || !settings.jevEnabled || !settings.jevSavingsEnabled) removeRecord(scope, savingsRecords);
    if (!settings.jevEnabled || !settings.jevSavingsEnabled || /(?:checkout|payment|account|login|orders?|cart)(?:[/.?_-]|$)/i.test(location.pathname)) return;
    const scopes = new Set();
    for (const scope of savingsRecords.keys()) if (roots.some((root) => scope.contains(root) || root.contains(scope))) scopes.add(scope);
    for (const anchor of priceUnits.keys()) {
      if (!roots.some((root) => root.contains(anchor) || anchor.contains(root))) continue;
      const scope = savingsScope(anchor);
      if (scope) scopes.add(scope);
    }
    const groups = [...scopes].filter((scope) => ![...scopes].some((outer) => outer !== scope && outer.contains(scope)));
    for (const scope of scopes) if (!groups.includes(scope)) removeRecord(scope, savingsRecords);
    for (const scope of groups) {
      const prepared = savingsCandidate(scope);
      if (!prepared) { removeRecord(scope, savingsRecords); continue; }
      const key = `savings:${JSON.stringify(prepared.candidate)}`;
      if (!aiMemo.has(key) && aiMemo.size < 32) aiMemo.set(key, { type: "savings", candidate: prepared.candidate, pending: true, sent: false, choice: null, anchors: new Set() });
      const entry = aiMemo.get(key);
      if (!entry) { removeRecord(scope, savingsRecords); continue; }
      if (entry.pending) {
        // Keep the node for reuse, but never display a stale difference while a changed pair is unverified.
        for (const badge of savingsRecords.get(scope)?.badges || []) badge.remove();
        entry.anchors.add(scope);
        continue;
      }
      const savings = C.pairSavings(prepared.candidate, entry.choice);
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
      else if (scope.contains(root) || root.contains(scope)) pending.add(scope);
    }
    if (pending.size > 100) { pending.clear(); pending.add(document.body); }
  }

  function queue(root) {
    if (!table || !root?.isConnected) return;
    queueAIContexts(root);
    pending.add(root.nodeType === Node.TEXT_NODE ? root.parentElement : root);
    if (pending.size > 100) { pending.clear(); pending.add(document.body); }
    schedule();
  }

  async function flush() {
    if (scanning || !table) return;
    scanning = true;
    hintCache = new WeakMap();
    if (themeRoots.size) {
      colorCache.clear();
      for (const { badges } of [...records.values(), ...savingsRecords.values()]) for (const badge of badges) {
        if (badge.isConnected && [...themeRoots].some((root) => root.contains(badge))) updateTheme(badge);
      }
      themeRoots.clear();
    }
    if (hintDirty) {
      hintDirty = false;
      const hint = detectPageHint();
      if (hint !== pageHint) { pageHint = hint; pending.add(document.body); }
    }
    for (const [anchor, visible] of visibilityTargets) {
      if (!anchor.isConnected) { visibilityTargets.delete(anchor); blockedPlacements.delete(anchor); continue; }
      if ([...visibilityRoots].some((root) => root.contains(anchor) || anchor.contains(root))) {
        const next = isVisible(anchor);
        const layout = blockedPlacements.get(anchor) ?? records.get(anchor)?.layout;
        const layoutChanged = layout !== undefined && layout !== layoutKey(anchor);
        if (next !== visible || layoutChanged || records.get(anchor)?.badges.some((badge) => badge.isConnected && !fits(badge))) pending.add(anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor);
        visibilityTargets.set(anchor, next);
      }
    }
    if (settings.jevSavingsEnabled) for (const [anchor, unit] of priceUnits) {
      if (anchor.isConnected && [...visibilityRoots].some((root) => root.contains(anchor) || anchor.contains(root)) && unit.struck.some((struck, i) => struck !== isStruck(anchor, unit.prices[i]))) pending.add(anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor);
    }
    for (const [scope, record] of savingsRecords) {
      if (!scope.isConnected) { removeRecord(scope, savingsRecords); continue; }
      if ([...visibilityRoots].some((root) => root.contains(scope) || scope.contains(root)) && (!isVisible(record.anchor) || record.badges.some((badge) => badge.isConnected && !fits(badge)))) pending.add(scope);
    }
    visibilityRoots.clear();
    const version = revision;
    const roots = [...pending].filter((root) => root?.isConnected);
    pending.clear();
    const topRoots = roots.filter((root) => !roots.some((other) => other !== root && other.contains(root)));
    const affected = [];
    for (const anchor of records.keys()) {
      if (!anchor.isConnected) removeRecord(anchor);
      else if (topRoots.some((root) => root.contains(anchor) || anchor.contains(root))) affected.push(anchor);
    }
    const seen = new Set(), unitsSeen = new Set();
    const affectedUnits = [];
    for (const anchor of priceUnits.keys()) {
      if (!anchor.isConnected) priceUnits.delete(anchor);
      else if (topRoots.some((root) => root.contains(anchor) || anchor.contains(root))) affectedUnits.push(anchor);
    }
    let visited = 0;
    try {
      for (const root of topRoots) {
        if (root.closest?.(SKIP)) continue;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) => node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
        });
        let node;
        while ((node = walker.nextNode())) {
          if (version !== revision || !table) return;
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
      void flushAI();
      if (pending.size || visibilityRoots.size || themeRoots.size || hintDirty) schedule();
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (!table) return;
    for (const mutation of mutations) {
      const element = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
      if (element?.closest(`[${MARK}]`)) continue;
      const changed = [...mutation.addedNodes, ...mutation.removedNodes];
      if (mutation.type === "childList" && changed.length && changed.every((n) => n.nodeType === Node.ELEMENT_NODE && n.hasAttribute(MARK))) continue;
      const stylesheet = element?.closest("style,link[rel='stylesheet']") || changed.some((node) => node.nodeType === Node.ELEMENT_NODE && (node.matches("style,link[rel='stylesheet']") || node.querySelector("style,link[rel='stylesheet']")));
      if (stylesheet) queueAppearance();
      if (element?.closest("form") || changed.some((n) => n.nodeType === Node.ELEMENT_NODE && (n.matches("form") || n.querySelector("form")))) hintDirty = true;
      if (mutation.type === "attributes" && ["class", "style", "data-theme", "data-color-mode", "data-color-scheme", "data-bs-theme"].includes(mutation.attributeName)) {
        queueAppearance(element);
        continue;
      }
      if (mutation.type === "childList") themeRoots.add(element);
      if (element?.matches('input[type="hidden"][name="currencyOfPreference"]') || changed.some((node) => node.nodeType === 1 && (node.matches('input[type="hidden"][name="currencyOfPreference"]') || node.querySelector('input[type="hidden"][name="currencyOfPreference"]')))) hintDirty = true;
      if (element?.closest("head,script") || mutation.attributeName === "content" || element === document.documentElement || changed.some((n) => n.nodeType === Node.ELEMENT_NODE && (n.matches("meta,script") || n.querySelector("meta,script")))) hintDirty = true;
      queue(mutation.target);
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["content", "data-currency", "hidden", "aria-hidden", "class", "style", "data-theme", "data-color-mode", "data-color-scheme", "data-bs-theme", "media", "disabled", "value", "name", "action", "type"] });

  async function refresh() {
    const id = ++refreshId;
    try {
      const state = await chrome.runtime.sendMessage({ type: "getState" });
      if (id !== refreshId) return;
      if (!state.ok) throw new Error(state.error);
      const next = state.settings;
      const settingsChanged = JSON.stringify(next) !== JSON.stringify(settings);
      const routeChanged = next.target !== settings.target || next.provider !== settings.provider;
      settings = next;
      if (settingsChanged) { resetAI(); revision++; }
      if (routeChanged) { clear(); table = null; }
      if (!settings.enabled || settings.excludedHosts.includes(location.hostname)) { clear(); table = null; return; }
      const response = await chrome.runtime.sendMessage({ type: "getRates" });
      if (id !== refreshId) return;
      if (!response.ok) throw new Error(response.error);
      if (JSON.stringify(response.table) === JSON.stringify(table)) {
        if (settingsChanged) queue(document.body);
        return;
      }
      revision++;
      table = response.table;
      hintDirty = true;
      queue(document.body);
    } catch {
      if (id === refreshId) { clear(); table = null; }
      // Fail closed: never replace original prices or show invented conversion rates.
    }
  }

  chrome.storage.onChanged.addListener((_, area) => { if (area === "sync") refresh(); });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "refresh") {
      if (message.resetJev) { resetAI(); revision++; queue(document.body); }
      refresh();
    }
  });
  window.addEventListener("resize", () => { queueAppearance(); queue(document.body); });
  // The event may change a page's CSS; the chosen palette still comes only from the actual background.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => queueAppearance());
  document.addEventListener("change", () => queueAppearance());
  document.addEventListener("load", (event) => { if (event.target.matches?.("link[rel='stylesheet']")) queueAppearance(); }, true);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { queueAppearance(); refresh(); } });
  setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60_000);
  refresh();
})();
