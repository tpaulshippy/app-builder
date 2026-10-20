export const CORE_A = `const log = document.getElementById("log");

// Surface script errors in the transcript. Without this a throw before the
// first render leaves the page silently idle.
window.addEventListener("error", (e) => {
  // Third-party scripts injected into the page (wallet shims, extensions,
  // antivirus/proxy injectors) run cross-origin, so their throws reach us
  // sanitized as "Script error." with no file or line. Our own inline script
  // always reports a filename, so a filenameless "Script error." cannot be
  // ours. Not actionable — drop it instead of alarming the transcript.
  if (e.message === "Script error." && !e.filename) {
    console.debug("ignored cross-origin script error");
    return;
  }
  const msg = e.message || String(e.error);
  // Brave on iOS injects a wallet script into every page that throws on
  // "window.ethereum.selectedAddress = undefined" because no provider is
  // injected. Not ours, not actionable. brave-ios#6656.
  if (msg.includes("ethereum.selectedAddress")) return;
  // Chrome on iOS injects GCrWeb helpers (__gCrWeb.*) into every page; when
  // they throw, window.onerror attributes them to our inline script. Not
  // ours, not actionable.
  if (msg.includes("__gCrWeb")) return;
  const n = document.createElement("div");
  n.className = "err";
  n.textContent = "js error: " + msg;
  log.appendChild(n);
});
const pane = document.getElementById("pane");
// Static-html Preview helpers (pure, unit-tested in tests/preview-assets.test.ts;
// serialized here so the page and the tests run the same code).
`;
export const CORE_B = `// Assistant markdown (pure, unit-tested in tests/markdown.test.ts; serialized
// here so the page and the tests run the same code).
// The worker TS transform wraps nested helpers with __name(), which has no
// browser definition — the identity shim below is what that helper does.
var __name = (fn) => fn;
`;
