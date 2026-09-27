// AI off, mock rates: JSON-LD Offer.priceCurrency may resolve ambiguous symbols only when it is the page's single explicit currency.
const table = { provider: "ecb", target: "CNY", rates: { USD: { rate: 0.1, asOf: "2026-09-22" }, CAD: { rate: 0.2, asOf: "2026-09-22" } }, fetchedAt: Date.now(), stale: false };
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
    check("single JSON-LD offer currency resolves an ambiguous $ without AI", () => badges("ambiguous")[0]?.textContent.includes("100.00") && badges("ambiguous")[0].title.includes("CAD"));
    check("explicit symbol still wins over page metadata", () => badges("explicit")[0]?.title.includes("(USD)") && badges("explicit")[0].textContent.includes("100.00"));
    const conflict = document.createElement("script");
    conflict.type = "application/ld+json";
    conflict.textContent = JSON.stringify({ "@type": "Offer", price: 5, priceCurrency: "USD" });
    document.head.append(conflict);
    await wait();
    check("conflicting JSON-LD currencies do not guess", () => !badges("ambiguous").length && badges("explicit").length === 1);
    conflict.remove();
    await wait();
    check("removing the conflict restores the single currency", () => badges("ambiguous").length === 1);
    const meta = document.createElement("meta");
    meta.setAttribute("property", "og:price:currency");
    meta.content = "USD";
    document.head.append(meta);
    await wait();
    check("JSON-LD and meta tags must agree", () => !badges("ambiguous").length);
    check("no AI request", () => messages.every((type) => type === "getState" || type === "getRates"));
    check("no runtime errors (malformed JSON-LD is ignored)", () => errors.length === 0);
    result.completed = true;
  } catch (e) { result.error = e.message; }
  result.errors = errors;
  el("dom-results").textContent = JSON.stringify(result);
});
