// Off-screen prices are converted when they approach the viewport, not during the first page-wide pass.
const table = { provider: "ecb", target: "CNY", rates: { USD: { rate: 0.1, asOf: "2026-09-22" } }, fetchedAt: Date.now(), stale: false };
const errors = [];
window.addEventListener("error", (e) => errors.push(e.message));
window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
globalThis.chrome = { i18n: window.PL_I18N,
  runtime: {
    sendMessage: async (message) => message.type === "getState" ? { ok: true, settings: { ...PriceLens.DEFAULTS } } : { ok: true, table: structuredClone(table) },
    onMessage: { addListener() {} },
  },
  storage: { onChanged: { addListener() {} } },
};
window.addEventListener("load", async () => {
  const result = { completed: false, systemDark: matchMedia("(prefers-color-scheme: dark)").matches, checks: [] };
  const el = (id) => document.getElementById(id);
  const count = (id, savings) => el(id).querySelectorAll(`[data-pricelens-savings="${savings}"]`).length;
  const wait = () => new Promise((resolve) => setTimeout(resolve, 420));
  const check = (name, test) => { try { result.checks.push({ name, pass: Boolean(test()) }); } catch (e) { result.checks.push({ name, pass: false, error: e.message }); } };
  try {
    await wait();
    check("prices near the viewport convert immediately", () => count("top", false) === 2 && count("top", true) === 1);
    check("far off-screen prices are deferred", () => count("far", false) === 0 && count("far", true) === 0);
    el("far").scrollIntoView();
    await wait();
    check("scrolling near deferred prices converts them and their difference", () => count("far", false) === 2 && count("far", true) === 1);
    window.scrollTo(0, 0);
    await wait();
    check("already rendered badges stay after scrolling away", () => count("far", false) === 2 && count("top", false) === 2);
    check("no runtime errors", () => errors.length === 0);
    result.completed = true;
  } catch (e) { result.error = e.message; }
  el("dom-results").textContent = JSON.stringify(result);
});
