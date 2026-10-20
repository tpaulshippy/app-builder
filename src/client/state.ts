export const STATE_JS = `const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
// The API key field lives in the Settings tab (renderGitHub): localStorage is
// the source of truth, the input just edits it when that tab is rendered.
const readApiKey = () => {
  const field = document.getElementById("apikey");
  const v = (field && field.value) || localStorage.getItem("ab_key") || "";
  return v.trim();
};
const modelSel = document.getElementById("model");
// Gateway (zen vs go) lives in Settings; localStorage is the source of truth
// so the composer works even when that tab was never rendered.
function getGateway() {
  const g = localStorage.getItem("ab_gateway") || DEFAULT_GATEWAY;
  return GATEWAYS[g] ? g : DEFAULT_GATEWAY;
}
// Paid models only: free *-free previews 403 outside the OpenCode client.
function fillModels(gw, keep) {
  const list = GATEWAYS[gw] || GATEWAYS[DEFAULT_GATEWAY];
  modelSel.innerHTML = "";
  for (const m of list) {
    const o = document.createElement("option");
    o.value = m; o.textContent = m;
    modelSel.appendChild(o);
  }
  modelSel.value = list.includes(keep) ? keep : list[0];
}
function setGateway(gw) {
  if (!GATEWAYS[gw]) gw = DEFAULT_GATEWAY;
  localStorage.setItem("ab_gateway", gw);
  fillModels(gw, modelSel.value);
  localStorage.setItem("ab_model", modelSel.value);
  const sel = document.getElementById("gateway");
  if (sel && sel.value !== gw) sel.value = gw;
}
fillModels(getGateway(), localStorage.getItem("ab_model") || DEFAULT_MODEL);
modelSel.onchange = () => localStorage.setItem("ab_model", modelSel.value);
const mBundle = document.getElementById("m-bundle");
const mBuilt = document.getElementById("m-built");

let view = "chat"; // single tab row: chat | history | preview | code | database | logs | github
let files = { "server/index.ts": "" };
let activeFile = "server/index.ts";
// Selected html file for Preview when the repo has no capsule.
let activePreview = null;
let built = null;
let busy = false;
// True from first paint until the boot status/state round-trip settles: the
// transcript shows a loading row meanwhile, and send stays off.
let booting = true;
// Anonymous until the boot status check (or any 401) says otherwise: the
// gate replaces every app view and hides its tabs, GitHub tab excepted.
let authed = false;
const gate = document.getElementById("gate");
const loginBtn = document.getElementById("loginbtn");
if (loginBtn) loginBtn.onclick = () => { window.location.href = "/api/github/login"; };
// The mounted preview iframe, if any: it reports login loss it sees first.
let appFrameEl = null;
// The sandboxed preview cannot reach apiFetch, so its shim posts an expiry
// message instead (source-checked: opaque-origin frames report "null").
window.addEventListener("message", (e) => {
  if (!e.data || e.data !== "app-builder:auth-required") return;
  if (!appFrameEl || e.source !== appFrameEl.contentWindow) return;
  if (authed) showGate();
});

/** Hide the app tabs until the visitor logs in; the GitHub tab stays. */
function syncGateTabs() {
  document.querySelectorAll("[data-view]").forEach((t) => {
    if (t.dataset.view === "github") return;
    t.style.display = authed ? "" : "none";
  });
  syncCapsuleTabs();
}

/** A repo counts as a capsule when it has both entries the capsule runtime needs. */
function hasCapsuleFiles() {
  return "server/index.ts" in files && "client/index.tsx" in files;
}

/**
 * The Database and Logs tabs only apply to capsule repos: without a server entry
 * there is no isolate state or console output to show, so the tabs stay hidden
 * and the pane falls back to Preview. Runs on every render, since opening
 * another repo can gain or lose the capsule entries at any time.
 */
function syncCapsuleTabs() {
  document.querySelectorAll('[data-view="database"], [data-view="logs"]').forEach((t) => {
    t.style.display = authed && hasCapsuleFiles() ? "" : "none";
  });
  if ((view === "database" || view === "logs") && !hasCapsuleFiles()) {
    view = "preview";
    syncTabs();
  }
}

/** Drop to the login gate, unmounting the preview frame so its shim stops polling. */
function showGate() {
  authed = false;
  syncGateTabs();
  appFrameEl = null;
  pane.innerHTML = "";
  // Drop the cached login state: the GitHub view renders from this cache,
  // and stale connected state would show authenticated controls after logout.
  ghStatus = null;
  ghMsg = "";
  ghRepos = [];
  ghResetBranches();
  ghClearBranchDrafts();
  updateRepoBadge(null);
  renderPane();
}

/**
 * A login-required 401 anywhere drops the app back to the gate. Both 401
 * shapes are recognized: the cookie APIs error string and the sid
 * endpoints ok-false error object.
 */
function noteLoginRequired(body) {
  const lost = !!body && (body.error === "github login required" ||
    (body.ok === false && body.error && body.error.message === "github login required"));
  if (lost && authed) showGate();
  return lost;
}

/** Authenticated API fetch: same as fetch, but a lost login shows the gate. */
async function apiFetch(url, init) {
  const r = await fetch(url, init);
  if (r.status === 401) {
    try { noteLoginRequired(await r.clone().json()); } catch { /* non-JSON 401: not ours */ }
  }
  return r;
}
// Bumped on every successful build so the app iframe reloads against fresh
// files. The iframe is otherwise left alone (remounts wipe its UI state).
let appV = 0;

const sessionId = () => {
  const m = document.cookie.match(/(?:^|; *)ab_session=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "";
};

/**
 * Preview capability for the cookieless iframe (see /api/share/preview):
 * minted per mount by the authenticated parent. The token rides the frame
 * URL (which already carries the sid); page scripts never need to read it.
 */
async function previewToken() {
  const r = await apiFetch("/api/share/preview", { method: "POST" }).then((r) => r.json());
  if (r.error) throw new Error(r.error);
  if (!r.preview) throw new Error("preview token missing");
  return r.preview;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

`;
