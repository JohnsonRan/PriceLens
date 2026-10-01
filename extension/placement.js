/* Where a badge may sit without reflowing or clipping the page, and which palette its background needs.
   Its only state is the background-colour sample cache, which content.js clears when stylesheets change. */
(() => {
  const { MARK, CONTROL, elementOf, composedParent, textOf, visuallyClipped, sourceRect } = PriceLensDom;
  const colorCache = new Map();
  let colorContext;

  function backgroundTheme(badge) {
    try {
      let remaining = 1;
      const color = [0, 0, 0];
      for (let el = composedParent(badge); el && remaining > 0; el = composedParent(el)) {
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
    let el = elementOf(anchor);
    for (let depth = 0; el && el !== document.body && depth < 5; depth++, el = el.parentElement) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      parts.push([rect.width, rect.height, style.display, style.position, style.overflowX, style.overflowY, style.maxWidth, style.maxHeight, style.clip, style.clipPath, style.webkitLineClamp, style.font, style.whiteSpace, style.textAlign, style.flexDirection, style.gridTemplateColumns].join("/"));
    }
    return parts.join("|");
  }

  function flowSnapshot(anchor) {
    let scope = elementOf(anchor);
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
    // A shrink-to-fit scope may widen into free space: keep the boxes of a few ancestors and their children to prove it.
    const outer = [];
    for (let el = scope.parentElement, depth = 0; el && el !== document.body && depth < 3; el = el.parentElement, depth++) {
      outer.push({ el, box: el.getBoundingClientRect(), kids: [...el.children].map((kid) => [kid, kid.getBoundingClientRect()]) });
    }
    return { scope, box: scope.getBoundingClientRect(), lines, outer };
  }

  // The scope only grew to the right, and so did each ancestor up to one that kept its width, whose other children did
  // not move sideways: the tag took free space beside a shrink-to-fit price box and pushed nothing along. As in
  // preservesFlow, the line may grow by up to the tag's height (small fonts), moving what follows down by as much.
  function grewIntoFreeSpace({ scope, box, outer }, badge) {
    const grow = badge.getBoundingClientRect().height;
    const same = (a, b, sides) => sides.every((side) => Math.abs(a[side] - b[side]) <= 1);
    const taller = (a, b) => b.height >= a.height - 1 && b.height <= a.height + grow;
    const widened = (a, b) => same(a, b, ["left", "top"]) && taller(a, b) && b.width > a.width;
    const unmoved = (a, b) => same(a, b, ["left", "width"]) && taller(a, b) && b.top >= a.top - 1 && b.top <= a.top + grow;
    if (!widened(box, scope.getBoundingClientRect())) return false;
    let child = scope;
    for (const { el, box: before, kids } of outer) {
      const now = el.getBoundingClientRect();
      if (unmoved(before, now)) {
        return kids.every(([kid, rect]) => kid === badge || (kid === child ? widened : unmoved)(rect, kid.getBoundingClientRect()));
      }
      if (!widened(before, now)) return false;
      child = el;
    }
    return false;
  }

  function preservesFlow(snapshot, badge, scrollbarDelta) {
    if (!snapshot) return true;
    const { scope, box, lines } = snapshot;
    const next = scope.getBoundingClientRect(), badgeBox = badge.getBoundingClientRect();
    const inside = scope.contains(badge);
    if (Math.abs(next.width - box.width) > scrollbarDelta + 1 && !grewIntoFreeSpace(snapshot, badge)) return false;
    if (Math.abs(next.height - box.height) > (inside ? badgeBox.height : 1)) return false;
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

  function placeBadge(anchor, badge, previous, position, badgeAnchors) {
    // Measure original flow without this badge, including when reusing it after resize or price changes.
    if (badge.isConnected) badge.style.display = "none";
    const before = sourceRect(anchor);
    const flow = flowSnapshot(anchor);
    const viewportWidth = document.documentElement.clientWidth;
    badge.style.removeProperty("display");
    const safe = () => {
      const after = sourceRect(anchor);
      const scrollbarDelta = Math.abs(document.documentElement.clientWidth - viewportWidth);
      const parent = composedParent(badge); // A shadow root's top-level badge is laid out by its host.
      // A badge must not become another flex/grid item and squeeze prices or neighboring controls.
      if (/flex|grid/.test(getComputedStyle(parent).display)) return false;
      // A details button stays outside host controls; a plain label is only for inside one (else it would be a dead tag).
      if (badge.tagName === "BUTTON" ? parent.closest(CONTROL) : !parent.closest(CONTROL)) return false;
      // Lifting one price's badge must not reverse it with another price's annotation. A reversal needs another
      // badge either between this anchor and badge, or in a badge run right after one of this badge's ancestors
      // (where a lifted badge is inserted), so only those few nodes are compared, not every badge nearby.
      const reversed = (other) => {
        const source = badgeAnchors.get(other);
        return other !== badge && source && source !== anchor && Boolean(source.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING) !== Boolean(other.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING);
      };
      const between = document.createTreeWalker(parent, NodeFilter.SHOW_ELEMENT);
      between.currentNode = anchor;
      if (parent.contains(anchor)) for (let node = between.nextNode(); node && node !== badge; node = between.nextNode()) if (node.hasAttribute(MARK) && reversed(node)) return false;
      for (let el = badge; el && el !== document.body; el = el.parentElement) {
        for (let next = el.nextElementSibling; next?.hasAttribute(MARK); next = next.nextElementSibling) if (reversed(next)) return false;
      }
      const rect = badge.getBoundingClientRect(), bounds = parent.getBoundingClientRect();
      return rect.left >= Math.max(0, bounds.left) - 1 && rect.right <= Math.min(document.documentElement.clientWidth, bounds.right) + 1 && fits(badge) && Math.abs(after.height - before.height) <= 1 && Math.abs(after.width - before.width) <= scrollbarDelta + 1 && preservesFlow(flow, badge, scrollbarDelta);
    };
    // A badge wrapped onto its own line needs no gap from the text before it; in a column exactly as wide as the
    // badge (Apple's right-aligned model selectors) that gap alone pushes it out of bounds.
    const startsLine = () => {
      const range = document.createRange();
      range.setStart(badge.parentNode, 0);
      range.setEndBefore(badge);
      const last = [...range.getClientRects()].filter((rect) => rect.width && rect.height).at(-1);
      return !last || last.bottom <= badge.getBoundingClientRect().top + 1;
    };
    const placedSafely = () => {
      badge.style.removeProperty("margin-inline-start");
      if (safe()) return true;
      badge.style.marginInlineStart = "0";
      return startsLine() && safe();
    };
    if (position && placedSafely()) return position;
    badge.remove();
    let target = previous;
    if (previous === anchor) {
      let el = elementOf(anchor);
      const original = textOf(anchor).trim();
      for (let depth = 0; el && el !== document.body && depth < 3; depth++, el = el.parentElement) {
        if (textOf(el).trim() !== original) break;
        if (["absolute", "fixed"].includes(getComputedStyle(el).position)) { target = el.parentElement; break; }
      }
    }
    for (let depth = 0; target?.parentNode && target !== document.body && target !== document.documentElement && depth < 3; depth++, target = target.parentElement) {
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
      if (placedSafely()) return target;
      badge.remove();
      // On fallback, step past inline wrappers to keep their words and price qualifiers together.
      while (target.parentElement && target.parentElement !== document.body && ["inline", "contents"].includes(getComputedStyle(target.parentElement).display)) target = target.parentElement;
    }
    return null;
  }

  globalThis.PriceLensPlacement = Object.freeze({ colorCache, backgroundTheme, fits, layoutKey, placeBadge });
})();
