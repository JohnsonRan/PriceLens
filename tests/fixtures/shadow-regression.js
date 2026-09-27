// Open shadow roots are converted with the extension stylesheet adopted into them; closed roots stay untouched.
const table = { provider: "ecb", target: "CNY", rates: { USD: { rate: 0.1, asOf: "2026-09-22" } }, fetchedAt: Date.now(), stale: false };
const errors = [], messages = [];
window.addEventListener("error", (e) => errors.push(e.message));
window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
globalThis.chrome = {
  runtime: {
    sendMessage: async (message) => {
      messages.push(message.type);
      if (message.type === "getState") return { ok: true, settings: { ...PriceLens.DEFAULTS } };
      if (message.type === "getRates") return { ok: true, table: structuredClone(table) };
      // The worker reads content.css; the test runner injects the same text as window.CONTENT_CSS.
      if (message.type === "getStyles") return { ok: true, css: window.CONTENT_CSS };
      throw new Error(`Unexpected request ${message.type}`);
    },
    onMessage: { addListener() {} },
  },
  storage: { onChanged: { addListener() {} } },
};
window.addEventListener("load", async () => {
  const result = { completed: false, systemDark: matchMedia("(prefers-color-scheme: dark)").matches, checks: [] };
  const el = (id) => document.getElementById(id);
  const inShadow = (host) => [...(host.shadowRoot?.querySelectorAll("[data-pricelens]") || [])];
  const wait = () => new Promise((resolve) => setTimeout(resolve, 420));
  const check = (name, test) => { try { result.checks.push({ name, pass: Boolean(test()) }); } catch (e) { result.checks.push({ name, pass: false, error: e.message }); } };
  try {
    await wait();
    const badge = inShadow(el("open-card"))[0];
    check("price inside an open shadow root converts", () => badge?.textContent.includes("100.00"));
    check("badge in shadow root receives the extension stylesheet", () => getComputedStyle(badge).display === "inline-block" && getComputedStyle(badge).borderTopStyle === "solid");
    check("stylesheet is requested once, not per root", () => messages.filter((type) => type === "getStyles").length === 1);
    check("closed shadow roots are never entered", () => !el("closed-card").shadowRoot && !document.querySelector("#closed-card [data-pricelens]"));
    const inner = el("nested").shadowRoot.querySelector("product-card");
    check("nested open shadow roots convert", () => inShadow(inner)[0]?.textContent.includes("100.00"));
    el("late-card").shadowRoot.innerHTML = "<p>USD 3</p>";
    await wait();
    check("mutations inside a shadow root are observed", () => inShadow(el("late-card"))[0]?.textContent.includes("30.00"));
    el("open-card").shadowRoot.querySelector("span").firstChild.data = "USD 4";
    await wait();
    check("price change inside shadow updates the same badge", () => inShadow(el("open-card"))[0] === badge && badge.textContent.includes("40.00"));
    const order = () => [...document.querySelectorAll("[data-pricelens]"), ...[el("open-card"), inner, el("late-card")].flatMap(inShadow)];
    const first = document.querySelector("#light [data-pricelens]");
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, composed: true, cancelable: true }));
    check("arrow keys move from light DOM into the next shadow badge in page order", () => el("open-card").shadowRoot.activeElement === badge);
    check("only one badge is a Tab stop across light and shadow DOM", () => order().filter((b) => b.tabIndex === 0).length === 1);
    badge.click();
    await wait();
    check("clicking a shadow badge opens the details dialog", () => document.querySelector("dialog.pricelens-details")?.open);
    check("no runtime errors", () => errors.length === 0);
    result.completed = true;
  } catch (e) { result.error = e.message; }
  result.errors = errors;
  el("dom-results").textContent = JSON.stringify(result);
});
