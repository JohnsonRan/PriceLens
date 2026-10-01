/* Read-only DOM helpers for the content-script files: selectors, visibility, text and ancestry. No page state. */
(() => {
  const C = PriceLens;
  const MARK = "data-pricelens";
  const TEXT_SKIP = `script,style,noscript,textarea,input,select,option,code,pre,svg,math,canvas,iframe,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[hidden],[${MARK}]`;
  const SKIP = `${TEXT_SKIP},sup,sub,[aria-hidden="true"]`;
  const PRODUCT = '[itemscope][itemtype$="/Product"],[data-product-id],[data-asin]:not([data-asin=""])';
  const CARD = `${PRODUCT},article,li,[role='listitem']`;
  const CURRENCY_SCOPE = `${CARD},[itemscope][itemtype$="/Offer"]`;
  const HEADING = "h1,h2,h3,h4,h5,h6";
  const CONTROL = 'a[href],button,summary,[role="button"],[role="link"]';
  const hostOf = (node) => node.parentNode || node.host || null;
  const holds = (outer, node) => { for (let n = node; n; n = hostOf(n)) if (n === outer) return true; return false; };
  const related = (a, b) => holds(a, b) || holds(b, a);
  const touchesAny = (roots, node) => [...roots].some((root) => related(root, node));
  const elementOf = (node) => node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const shown = (el) => el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) !== false;

  // Emails and phone-like digit runs are stripped from context snippets before any use.
  const redact = (text) => text.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[邮箱已移除]").replace(/\+?\d[\d ()-]{7,}\d/g, "[长数字已移除]");
  const composedParent = (el) => el.parentElement || el.getRootNode().host || null;

  function composedOrder(a, b) {
    const chain = (n) => { const c = [n]; for (let r = n.getRootNode(); r instanceof ShadowRoot; r = r.host.getRootNode()) c.push(r.host); return c; };
    const ca = chain(a), cb = chain(b);
    for (const x of ca) for (const y of cb) if (x !== y && x.getRootNode() === y.getRootNode()) return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    return 0;
  }

  function textOf(node, visibleOnly = false, includeMirrors = false) {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (visibleOnly && (visuallyClipped(node) || getComputedStyle(node).visibility !== "visible" || getComputedStyle(node).display === "none")) return "";
    let text = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child.matches(includeMirrors ? TEXT_SKIP : SKIP)) continue;
      const part = textOf(child, visibleOnly, includeMirrors);
      // Digits split across elements ("19" + styled "99") are not one number; a space makes them unparseable instead of 1999.
      text += child.nodeType === Node.ELEMENT_NODE && /\d$/.test(text) && /^\d/.test(part) ? ` ${part}` : part;
      if (text.length > 160) break;
    }
    return text;
  }

  function visuallyClipped(el) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    // Offscreen accessibility labels can retain a normal text size without a clip rectangle.
    const offscreen = style.position === "absolute" && (parseFloat(style.left) < -1000 || parseFloat(style.top) < -1000);
    return Number(style.opacity) === 0 || offscreen || (rect.width <= 1 && rect.height <= 1) || !["auto", "none"].includes(style.clip) || style.clipPath !== "none";
  }

  function isVisible(anchor) {
    const el = elementOf(anchor);
    return Boolean(el?.isConnected && !el.closest(SKIP) && !visuallyClipped(el) && [...el.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0) && getComputedStyle(el).visibility === "visible");
  }

  function sourceRect(anchor) {
    if (anchor.nodeType === Node.ELEMENT_NODE) return anchor.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(anchor);
    return range.getBoundingClientRect();
  }

  // "$19<sup>99</sup>", "<sup>$</sup>19<sup>99</sup>", "1.299<sup>99</sup> €": join superscript cents and
  // currency marks into one amount. Any other sup/sub (footnotes, units) keeps the element unsupported.
  function superscriptText(el) {
    let text = "";
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) { text += child.data; continue; }
        if (child.nodeType !== Node.ELEMENT_NODE || child.matches(`${TEXT_SKIP},[aria-hidden="true"]`)) continue;
        if (!child.matches("sup,sub")) { if (!walk(child)) return false; continue; }
        const part = child.textContent.trim();
        if (/^\d{2}$/.test(part) && /\d$/.test(text.trimEnd())) {
          text = text.trimEnd();
          // Dot thousands ("1.299") mean a comma decimal.
          text += /\.\d{3}$/.test(text) ? `,${part}` : `.${part}`;
        } else if (/^\d{2}$/.test(part) && /[.,]$/.test(text.trimEnd())) text = text.trimEnd() + part;
        else if (part && part.length <= 4 && !/\d/.test(part) && C.findPrices(`${part}1`, "", true).length === 1) text += part;
        else return false;
      }
      return true;
    };
    return walk(el) ? text : null;
  }

  function crossesProducts(scope, origin) {
    if (scope.querySelectorAll(HEADING).length > 1) return true;
    if ([...scope.querySelectorAll(CARD)].some((card) => !origin || !card.contains(origin))) return true;
    const links = [...scope.querySelectorAll("a[href]")].filter((link) => link.querySelector(`img,${HEADING}`));
    return new Set(links.map((link) => link.getAttribute("href"))).size > 1;
  }

  function isStruck(anchor, price) {
    const el = elementOf(anchor);
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
      const values = C.findPrices(textOf(mirror, true, true), price.currency);
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

  globalThis.PriceLensDom = Object.freeze({ MARK, SKIP, CARD, CURRENCY_SCOPE, HEADING, CONTROL, holds, related, touchesAny, elementOf, shown, redact, composedParent, composedOrder, textOf, visuallyClipped, isVisible, sourceRect, superscriptText, crossesProducts, isStruck });
})();
