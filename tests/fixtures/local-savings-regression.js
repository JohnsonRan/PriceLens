// AI off, mock rates, no network: reference differences must come only from page markup or strike formatting.
const settings = { ...PriceLens.DEFAULTS };
const table = { provider: "ecb", target: "CNY", rates: { USD: { rate: 0.1, asOf: "2026-09-22" }, GBP: { rate: 0.1, asOf: "2026-09-22" }, EUR: { rate: 0.1, asOf: "2026-09-22" } }, fetchedAt: Date.now(), stale: false };
const listeners = [], messages = [], runtimeErrors = [];
window.addEventListener("error", (e) => runtimeErrors.push(e.message));
window.addEventListener("unhandledrejection", (e) => runtimeErrors.push(String(e.reason)));
globalThis.chrome = {
  runtime: {
    sendMessage: async (message) => {
      messages.push(message.type);
      if (message.type === "getState") return { ok: true, settings: { ...settings } };
      if (message.type === "getRates") return { ok: true, table: structuredClone(table) };
      throw new Error(`Unexpected request ${message.type}`);
    },
    onMessage: { addListener: (listener) => listeners.push(listener) },
  },
  storage: { onChanged: { addListener() {} } },
};
window.addEventListener("load", async () => {
  const result = { completed: false, systemDark: matchMedia("(prefers-color-scheme: dark)").matches, checks: [] };
  const el = (id) => document.getElementById(id);
  const badges = (id) => [...el(id).querySelectorAll('[data-pricelens-savings="true"]')];
  const wait = () => new Promise((resolve) => setTimeout(resolve, 420));
  const check = (name, test) => { try { result.checks.push({ name, pass: Boolean(test()) }); } catch (e) { result.checks.push({ name, pass: false, error: e.message }); } };
  try {
    await wait();
    const structured = badges("structured")[0];
    check("schema.org StrikethroughPrice pairs unstruck text without AI", () => structured?.textContent.includes("50.00") && !structured.textContent.includes("AI") && structured.title.includes("结构化数据"));
    check("member-tier specification does not become the current price", () => badges("structured-extra")[0]?.textContent.includes("100.00") && badges("structured-extra").length === 1);
    const strike = badges("strike")[0];
    check("one struck and one unstruck amount pair locally", () => strike?.textContent.includes("200.00") && !strike.textContent.includes("AI") && strike.title.includes("划线格式"));
    check("CSS line-through counts as strike evidence", () => badges("css-strike")[0]?.textContent.includes("150.00"));
    check("conditional member wording skips the local strike rule", () => !badges("member").length);
    check("three amounts are ambiguous without AI", () => !badges("three").length);
    check("no strike and no markup shows no difference", () => !badges("plain").length);
    check("struck amount below current is not a reference", () => !badges("cheaper-strike").length);
    check("adjacent products are never paired", () => !badges("adjacent").length);
    check("ordinary conversion still shows", () => Boolean(el("plain").querySelector('[data-pricelens-savings="false"]')));
    el("strike-current").firstChild.data = "USD 70";
    await wait();
    check("price change updates the local difference in place", () => badges("strike")[0] === strike && strike.textContent.includes("300.00"));
    check("late product still lacks markup", () => !badges("late").length);
    const script = document.createElement("script");
    script.type = "application/ld+json";
    script.textContent = JSON.stringify({ "@type": "Offer", price: 25, priceCurrency: "GBP", priceSpecification: { priceType: "https://schema.org/ListPrice", price: 30, priceCurrency: "GBP" } });
    document.head.append(script);
    await wait();
    check("markup added after load is picked up", () => badges("late")[0]?.textContent.includes("50.00"));
    settings.savingsEnabled = false;
    listeners.forEach((listener) => listener({ type: "refresh" }));
    await wait();
    check("opt-out removes differences but keeps conversion", () => !document.querySelector('[data-pricelens-savings="true"]') && Boolean(document.querySelector('[data-pricelens-savings="false"]')));
    settings.savingsEnabled = true;
    listeners.forEach((listener) => listener({ type: "refresh" }));
    await wait();
    check("opt-in restores structured and strike differences", () => badges("structured").length === 1 && badges("strike").length === 1 && badges("late").length === 1);
    check("no AI request was ever made", () => messages.every((type) => type === "getState" || type === "getRates"));
    check("no runtime errors", () => runtimeErrors.length === 0);
    result.errors = runtimeErrors;
    result.completed = true;
  } catch (e) { result.error = e.message; }
  el("dom-results").textContent = JSON.stringify(result);
});
