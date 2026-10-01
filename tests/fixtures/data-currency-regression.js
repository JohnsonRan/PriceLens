// AI off, mock rates: a single currency declared in the page's inline app data resolves only compatible ambiguous symbols.
const table = { provider: "ecb", target: "CNY", rates: { USD: { rate: 0.1, asOf: "2026-09-22" }, CAD: { rate: 0.2, asOf: "2026-09-22" }, JPY: { rate: 5, asOf: "2026-09-22" } }, fetchedAt: Date.now(), stale: false };
const messages = [], errors = [];
window.addEventListener("error", (e) => errors.push(e.message));
window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
globalThis.chrome = { i18n: window.PL_I18N,
  runtime: {
    sendMessage: async (message) => {
      messages.push(message.type);
      if (message.type === "getState") return { ok: true, settings: { ...PriceLens.DEFAULTS } };
      if (message.type === "getRates") return { ok: true, table: structuredClone(table) };
      throw new Error(`Unexpected request ${message.type}`);
    },
    onMessage: { addListener() {} },
  },
  storage: { onChanged: { addListener() {} } },
};
window.addEventListener("load", async () => {
  const result = { completed: false, systemDark: matchMedia("(prefers-color-scheme: dark)").matches, checks: [] };
  const el = (id) => document.getElementById(id);
  const badges = (id) => [...el(id).querySelectorAll("[data-pricelens]")];
  const wait = () => new Promise((resolve) => setTimeout(resolve, 350));
  const check = (name, test) => { try { result.checks.push({ name, pass: Boolean(test()) }); } catch (e) { result.checks.push({ name, pass: false, error: e.message }); } };
  try {
    await wait();
    check("single inline-data currency resolves an ambiguous $ without AI", () => badges("ambiguous")[0]?.textContent.includes("299.95") && badges("ambiguous")[0].title.includes("CAD"));
    check("a $ currency never resolves ¥", () => !badges("yen").length);
    check("explicit symbol still wins over page data", () => badges("explicit")[0]?.title.includes("(USD)"));
    const conflict = document.createElement("script");
    conflict.type = "application/json";
    conflict.textContent = JSON.stringify({ cart: { currencyCode: "USD" } });
    document.body.append(conflict);
    await wait();
    check("conflicting inline data currencies do not guess", () => !badges("ambiguous").length && badges("explicit").length === 1);
    conflict.textContent = JSON.stringify({ cart: { currencyCode: "CAD" } });
    await wait();
    check("editing the data to agree restores the hint", () => badges("ambiguous").length === 1);
    conflict.remove();
    const shopify = document.createElement("script");
    shopify.textContent = 'window.Shopify = window.Shopify || {}; Shopify.currency = {"active":"USD","rate":"0.73"};';
    document.head.append(shopify);
    await wait();
    check("a Shopify presentment currency that differs from the data is a conflict", () => !badges("ambiguous").length);
    shopify.remove();
    await wait();
    const meta = document.createElement("meta");
    meta.setAttribute("property", "og:price:currency");
    meta.content = "USD";
    document.head.append(meta);
    await wait();
    check("inline data and meta tags must agree", () => !badges("ambiguous").length);
    meta.remove();
    await wait();
    check("removing conflicting meta restores hint", () => badges("ambiguous").length === 1);

    const rscConflict = document.createElement("script");
    rscConflict.textContent = 'self.__next_f = self.__next_f || []; self.__next_f.push([1,"{\\"currency\\":\\"USD\\"}"]);';
    document.body.append(rscConflict);
    await wait();
    check("escaped RSC currency conflicting with page data disables hint", () => !badges("ambiguous").length);
    rscConflict.remove();
    await wait();

    const displayConflict = document.createElement("script");
    displayConflict.type = "application/json";
    displayConflict.textContent = JSON.stringify({ displayCurrency: "EUR" });
    document.body.append(displayConflict);
    await wait();
    check("displayCurrency differing from price data is a conflict", () => !badges("ambiguous").length);
    displayConflict.remove();
    await wait();

    const nextScript = el("__NEXT_DATA__");
    const originalNextData = nextScript.textContent;
    nextScript.textContent = JSON.stringify({ freeShipping: { currency: "CAD" } });
    await wait();
    check("free-shipping-only config is not enough to resolve ambiguous price", () => !badges("ambiguous").length);
    nextScript.textContent = originalNextData;
    await wait();
    check("restoring price-shaped data restores the hint", () => badges("ambiguous").length === 1);

    const bigScript = document.createElement("script");
    bigScript.textContent = "/*" + "x".repeat(5_000_001) + "*/";
    document.body.append(bigScript);
    await wait();
    check("oversized script disables hint instead of silently skipping", () => !badges("ambiguous").length);
    bigScript.remove();
    await wait();
    check("removing oversized script restores hint", () => badges("ambiguous").length === 1);

    // JS literals and API shapes that name a different display currency must veto too, not just quoted JSON keys.
    for (const [name, text] of [
      ["single-quoted JS config", "window.gtag = window.gtag || function () {}; window.storeConfig = { displayCurrency: 'USD' }; gtag('set', { currency: 'USD' });"],
      ["lower-case code", 'window.__pay = {"currency":"usd"};'],
      ["nested currency object", 'window.__s = {"session":{"currency":{"code":"USD","symbol":"$"}}};'],
    ]) {
      const veto = document.createElement("script");
      veto.textContent = text;
      document.body.append(veto);
      await wait();
      check(`${name} differing from the price data vetoes the hint`, () => !badges("ambiguous").length);
      veto.remove();
      await wait();
    }
    const switcher = document.createElement("label");
    switcher.innerHTML = 'Currency <select name="currency"><option value="CAD">CAD</option><option value="USD" selected>USD</option></select>';
    document.body.append(switcher);
    await wait();
    check("a currency switcher showing another currency vetoes the hint", () => !badges("ambiguous").length);
    switcher.querySelector("select").value = "CAD";
    switcher.querySelector("select").dispatchEvent(new Event("change", { bubbles: true }));
    await wait();
    check("switching it to the price data's currency restores the hint", () => badges("ambiguous").length === 1);
    switcher.remove();
    await wait();
    nextScript.textContent = JSON.stringify({ freeShippingMinimum: { amount: 50, currency: "CAD" } });
    await wait();
    check("a free-shipping threshold with an amount is still not a product price", () => !badges("ambiguous").length);
    nextScript.textContent = originalNextData;
    await wait();
    check("price data restored after the veto cases", () => badges("ambiguous").length === 1);

    check("no AI request", () => messages.every((type) => type === "getState" || type === "getRates"));
    check("no runtime errors", () => errors.length === 0);
    result.completed = true;
  } catch (e) { result.error = e.message; }
  result.errors = errors;
  el("dom-results").textContent = JSON.stringify(result);
});
