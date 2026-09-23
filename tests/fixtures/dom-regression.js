const settings = { ...PriceLens.DEFAULTS, jevEnabled: false };
const table = { provider: "ecb", target: "CNY", rates: { USD: { rate: 0.125, asOf: "2026-09-21" }, EUR: { rate: 0.1, asOf: "2026-09-21" }, JPY: { rate: 20, asOf: "2026-09-21" } }, fetchedAt: Date.now(), stale: false };
const listeners = [];
const runtimeErrors = [];
window.addEventListener("error", (event) => runtimeErrors.push(event.message));
window.addEventListener("unhandledrejection", (event) => runtimeErrors.push(String(event.reason)));
let aiRequests = 0;
globalThis.chrome = {
  runtime: {
    sendMessage: async ({ type }) => {
      if (type === "getState") return { ok: true, settings: { ...settings } };
      if (type === "getRates") return { ok: true, table: structuredClone(table) };
      if (type === "inferJev") aiRequests++;
      return { ok: false, error: "Unexpected message" };
    },
    onMessage: { addListener: (listener) => listeners.push(listener) },
  },
  storage: { onChanged: { addListener() {} } },
};

window.addEventListener("load", async () => {
  const result = { completed: false, systemDark: matchMedia("(prefers-color-scheme: dark)").matches, checks: [] };
  const byId = (id) => document.getElementById(id);
  const badges = (id) => {
    const found = [...byId(id).querySelectorAll("[data-pricelens]")];
    for (let next = byId(id).nextElementSibling; next?.matches("[data-pricelens]"); next = next.nextElementSibling) found.push(next);
    return found;
  };
  const after = (id) => byId(id).nextElementSibling?.matches("[data-pricelens]") ? byId(id).nextElementSibling : null;
  const wait = () => new Promise((resolve) => setTimeout(resolve, 260));
  function check(name, condition, detail = () => undefined) {
    try { const pass = Boolean(condition()); result.checks.push({ name, pass, detail: pass ? undefined : { ...detail(), runtimeErrors: [...runtimeErrors] } }); }
    catch (error) { result.checks.push({ name, pass: false, error: error.message }); }
  }
  try {
    const capsuleWidth = byId("yahoo-price").getBoundingClientRect().width;
    const pictureHeight = byId("yahoo-picture").getBoundingClientRect().height;
    const promoHeight = byId("promo-line").offsetHeight;
    const choiceHeight = byId("narrow-choice").offsetHeight;
    const optionHeight = byId("option-copy").offsetHeight;
    const controlWidth = byId("flex-control").offsetWidth;
    await wait();
    const stable = badges("stable")[0];
    check("baseline local conversion", () => stable?.textContent.includes("800.00"));
    check("Amazon search uses stated JPY and displays outside screen-reader text", () => after("amazon-search")?.textContent.includes("199.00") && !byId("amazon-search").querySelector("[data-pricelens]"));
    check("Amazon detail JP¥ price has visible adjacent annotation", () => after("amazon-detail")?.textContent.includes("332.50") && !byId("amazon-detail").querySelector("[data-pricelens]"));
    check("Amazon raw accessible price is never modified", () => byId("amazon-detail").querySelector(".a-offscreen").textContent === "JP¥6,650");
    check("visual whole/fraction duplicate creates exactly one conversion", () => byId("decimal-host").querySelectorAll("[data-pricelens]").length === 1 && after("amazon-decimal")?.textContent.includes("399.92"));
    check("Yahoo-style overlay price gets a visible label outside the image and capsule", () => {
      const badge = byId("yahoo-card").querySelector("[data-pricelens]");
      return badge?.textContent.includes("750.00") && !byId("yahoo-picture").contains(badge) && badge.getBoundingClientRect().top >= byId("yahoo-picture").getBoundingClientRect().bottom - 1;
    });
    check("original price capsule and image dimensions never expand", () => byId("yahoo-price").textContent === "15,000円" && byId("yahoo-price").getBoundingClientRect().width === capsuleWidth && byId("yahoo-picture").getBoundingClientRect().height === pictureHeight);
    check("fixed-height clipped row uses a safe adjacent flow position", () => after("clipped-row")?.textContent.includes("240.00") && !byId("clipped-row").querySelector("[data-pricelens]"));
    check("accessible-price extraction works without Amazon class names", () => after("generic-widget")?.textContent.includes("204.00") && !byId("generic-widget").querySelector("[data-pricelens]"));
    check("no safe position means no invisible badge or expanded capsule", () => !byId("no-room").querySelector("[data-pricelens]") && byId("unsafe-price").textContent === "USD 50");
    check("continuous promotional copy keeps its original lines", () => byId("promo-line").offsetHeight <= promoHeight + 4 && badges("promo-line").length === 2);
    check("narrow price and its qualifier stay together with conversion outside", () => byId("narrow-choice").offsetHeight === choiceHeight && badges("narrow-choice").length === 1);
    check("independent price blocks keep their extra conversion row", () => after("flow-price")?.textContent.includes("296.00") && byId("flow-card").contains(after("flow-price")));
    check("narrow multi-price option keeps original lines and source order", () => byId("option-copy").offsetHeight === optionHeight && badges("option-copy").length === 2 && badges("option-copy")[0].title.startsWith("219,800円") && badges("option-copy")[1].title.startsWith("6,105円"));
    check("flex controls are not squeezed by new flex-item badges", () => byId("flex-control").offsetWidth === controlWidth && !byId("flex-card").querySelector("[data-pricelens]") && after("flex-card")?.textContent.includes("392.00"));
    const resizeBadge = badges("resize-copy")[0];
    byId("resize-copy").style.width = "155px";
    window.dispatchEvent(new Event("resize"));
    await wait();
    const resizedHeight = byId("resize-copy").offsetHeight;
    check("existing badge moves outside newly narrow prose without disappearing", () => badges("resize-copy")[0] === resizeBadge && !byId("resize-copy").contains(resizeBadge));
    byId("resize-price").firstChild.data = "USD 200000";
    await wait();
    check("updated amount reuses a safe badge outside original copy", () => badges("resize-copy")[0] === resizeBadge && resizeBadge.textContent.includes("1,600,000.00") && byId("resize-copy").offsetHeight <= resizedHeight + 24);
    let annotationChanges = 0;
    const observer = new MutationObserver((records) => { annotationChanges += records.filter((r) => [...r.addedNodes, ...r.removedNodes].some((n) => n.nodeType === 1 && n.hasAttribute("data-pricelens"))).length; });
    observer.observe(byId("hover-root"), { subtree: true, childList: true });
    for (let i = 0; i < 4; i++) {
      byId("hover-root").className = `hover-${i}`;
      document.body.style.setProperty("--scroll-position", String(i));
      await wait();
    }
    observer.disconnect();
    check("hover/scroll style churn never replaces an unchanged badge", () => badges("stable")[0] === stable && annotationChanges === 0);
    byId("stable").firstChild.data = "USD 120";
    await wait();
    check("price change updates existing badge in place", () => badges("stable").length === 1 && badges("stable")[0] === stable && stable.textContent.includes("960.00"));
    byId("insertions").append(Object.assign(document.createElement("p"), { textContent: "EUR 7" }));
    await wait();
    check("new unrelated subtree does not rebuild other badges", () => badges("insertions").length === 1 && badges("stable")[0] === stable, () => ({ inserted: byId("insertions").outerHTML, next: byId("insertions").nextElementSibling?.outerHTML, count: badges("insertions").length, sameStable: badges("stable")[0] === stable, parsed: PriceLens.findPrices("EUR 7", "JPY"), rect: byId("insertions").firstChild.getBoundingClientRect().toJSON(), visibility: getComputedStyle(byId("insertions").firstChild).visibility }));
    let tick = 0;
    const animation = setInterval(() => document.body.style.setProperty("--animation", String(tick++)), 20);
    byId("insertions").append(Object.assign(document.createElement("p"), { id: "during-animation", textContent: "USD 8" }));
    await wait();
    check("continuous unrelated style animation cannot starve a newly loaded price", () => after("during-animation")?.textContent.includes("64.00"));
    clearInterval(animation);
    for (const el of [byId("no-room"), ...byId("no-room").querySelectorAll(".bounded")]) Object.assign(el.style, { width: "240px", height: "auto", overflow: "visible", whiteSpace: "normal" });
    await wait();
    check("a previously unsafe price is retried when its layout constraints change", () => byId("no-room").querySelectorAll("[data-pricelens]").length === 1);
    byId("hover-root").className = "show-hidden";
    await wait();
    check("ancestor class can reveal a previously hidden price", () => badges("css-hidden").length === 1 && badges("stable")[0] === stable);
    byId("hover-root").className = "";
    await wait();
    check("hidden price removes only its own badge", () => badges("css-hidden").length === 0 && badges("stable")[0] === stable);
    let detail = after("amazon-detail");
    byId("amazon-detail").querySelector(".a-offscreen").firstChild.data = "JP¥5,000";
    byId("amazon-detail").querySelector(".a-price-whole").firstChild.data = "5,000";
    await wait();
    check("Amazon variant price changes reuse the badge and canonical amount", () => after("amazon-detail") === detail && detail?.textContent.includes("250.00"));
    byId("amazon-nav").textContent = '{"currencyInfo":{"code":"CNY","copEnabled":true}}';
    await wait();
    check("currency preference changes remove same-currency price without disturbing explicit JPY", () => !after("amazon-search") && after("amazon-detail") === detail);
    table.rates.USD.rate = 0.1;
    table.fetchedAt++;
    listeners.forEach((listener) => listener({ type: "refresh" }));
    await wait();
    check("rate refresh updates instead of removing all annotations", () => badges("stable")[0] === stable && stable.textContent.includes("1,200.00"));
    const previousDetail = detail;
    const replacement = byId("amazon-detail").cloneNode(true);
    replacement.querySelector(".a-offscreen").textContent = "JP¥7,000";
    replacement.querySelector(".a-price-whole").textContent = "7,000";
    byId("amazon-detail").replaceWith(replacement);
    await wait();
    detail = after("amazon-detail");
    check("replacing a price widget cleans the old annotation and creates just one new one", () => !previousDetail.isConnected && byId("detail-host").querySelectorAll("[data-pricelens]").length === 1 && detail?.textContent.includes("350.00") && badges("stable")[0] === stable);
    byId("amazon-detail").remove();
    await wait();
    check("removing source widget removes its adjacent badge", () => !detail?.isConnected);
    check("same-currency price is untouched and AI was never requested", () => badges("same").length === 0 && aiRequests === 0);
    const themeOf = (id) => after(id)?.dataset.pricelensTheme;
    const bgOf = (id) => getComputedStyle(after(id)).backgroundColor;
    check("light webpage chooses light palette regardless of system preference", () => themeOf("inherit-price") === "light" && bgOf("inherit-price") === "rgb(234, 246, 239)");
    check("dark local card chooses dark palette even on a light webpage", () => themeOf("dark-price") === "dark" && bgOf("dark-price") === "rgb(24, 46, 36)");
    check("translucent backgrounds composite over their actual ancestors", () => themeOf("alpha-price") === "light");
    check("gradient background uses an opaque high-contrast fallback", () => themeOf("gradient-price") === "light" && bgOf("gradient-price") === "rgb(234, 246, 239)");
    const yahooBadge = byId("yahoo-card").querySelector("[data-pricelens]");
    check("Yahoo label uses its final light location, not the black price capsule", () => yahooBadge?.dataset.pricelensTheme === "light");
    const existing = [...document.querySelectorAll("[data-pricelens]")];
    const sizes = existing.map((badge) => [badge.offsetWidth, badge.offsetHeight]);
    let themeWrites = 0;
    let badgeReplacements = 0;
    const themeObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes" && mutation.target.hasAttribute("data-pricelens")) themeWrites++;
        if ([...mutation.addedNodes, ...mutation.removedNodes].some((node) => node.nodeType === 1 && node.hasAttribute("data-pricelens"))) badgeReplacements++;
      }
    });
    themeObserver.observe(document.body, { subtree: true, childList: true, attributes: true });
    document.body.dataset.theme = "dark";
    await wait();
    check("page theme switch updates transparent locations but preserves white cards", () => themeOf("inherit-price") === "dark" && themeOf("light-price") === "light" && yahooBadge.dataset.pricelensTheme === "dark");
    check("theme changes keep every badge node and size with no AI requests", () => existing.every((badge, i) => badge.isConnected && badge.offsetWidth === sizes[i][0] && badge.offsetHeight === sizes[i][1]) && badgeReplacements === 0 && themeWrites > 0 && aiRequests === 0);
    themeWrites = 0;
    document.body.classList.add("cosmetic-only");
    await wait();
    check("unchanged palette causes no badge DOM writes", () => themeWrites === 0 && badgeReplacements === 0);
    const sheet = document.createElement("style");
    sheet.textContent = "#theme-dark { background: #fff; }";
    document.head.append(sheet);
    await wait();
    check("stylesheet updates re-evaluate local colors without rebuilding badges", () => themeOf("dark-price") === "light" && existing.every((badge) => badge.isConnected) && badgeReplacements === 0);
    themeObserver.disconnect();
    settings.enabled = false;
    listeners.forEach((listener) => listener({ type: "refresh" }));
    await wait();
    check("global disable cleans up annotations", () => !document.querySelector("[data-pricelens]"));
    check("content script has no runtime errors", () => runtimeErrors.length === 0);
    result.completed = true;
  } catch (error) { result.error = error.message; }
  byId("dom-results").textContent = JSON.stringify(result);
});
