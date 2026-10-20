export const TABS_JS = `function syncTabs() {
  document.querySelectorAll("[data-view]").forEach((o) => {
    if (o.dataset.view === view) o.setAttribute("aria-selected", "true");
    else o.removeAttribute("aria-selected");
  });
}
function selectTab(elm) {
  // One tab row: the header tab names the only visible view.
  if (!elm.dataset.view) return;
  // The gate hides app tabs for anonymous visitors; ignore clicks that slip
  // through (keyboard focus) so the gate cannot be bypassed client-side.
  if (!authed && elm.dataset.view !== "github") return;
  // The Database tab is hidden without a capsule; ignore focus-driven
  // selection the same way so a hidden tab never becomes the live view.
  if (elm.dataset.view === "database" && !hasCapsuleFiles()) return;
  view = elm.dataset.view;
  syncTabs();
  renderPane();
}
document.querySelectorAll("[data-view]").forEach((n) => {
  n.onclick = () => selectTab(n);
  n.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectTab(n); } };
});

(async () => {
  const loading = el("div", "msg thinking", "Loading session…");
  log.appendChild(loading);
  mBuilt.textContent = "loading…";
  sendBtn.disabled = true;
  try {
    // Invite links land here as /?invite=<playground>.<code>: redeem first
    // so the cookies name the shared playground before anything else loads.
    const inviteParam = new URLSearchParams(location.search).get("invite");
    if (inviteParam) {
      history.replaceState(null, "", "/");
      try {
        const j = await fetch("/api/share/join", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: inviteParam }),
        }).then((r) => r.json());
        if (j.error) throw new Error(j.error);
        location.reload();
        return;
      } catch (e) {
        loading.remove();
        mBuilt.textContent = "invite error";
        mBuilt.className = "failed";
        log.appendChild(el("div", "err", "invite failed: " + (e.message ?? e)));
        return;
      }
    }
    // Gated behind GitHub login: learn the login state first, and only load
    // files/chat history for connected sessions. Anonymous visitors land on
    // the gate; the 302 to / after OAuth re-runs this connected.
    const g = await fetch("/api/github/status", { cache: "no-store" }).then((r) => r.json());
    ghStatus = g;
    authed = !!(g && g.connected);
    syncGateTabs();
    updateRepoBadge(g && g.linked);
    if (!authed) { loading.remove(); mBuilt.textContent = "idle"; renderPane(); return; }
    // no-store: /api/state runs a build, so any cached copy is already wrong.
    const s = await apiFetch("/api/state", { cache: "no-store" }).then((r) => r.json());
    if (s.error) {
      // Logged out between the status check and here (logout in another tab):
      // fall back to the gate instead of a stuck error.
      if (s.error === "github login required") { loading.remove(); mBuilt.textContent = "idle"; showGate(); return; }
      throw new Error(s.error);
    }
    files = s.files || files;
    built = s.built;
    if (typeof s.version === "number") filesVersion = s.version;
    setMetrics(built);
    renderHistory(s.messages);
    renderPane();
  } catch (e) {
    loading.remove();
    mBuilt.textContent = "state error";
    mBuilt.className = "failed";
    log.appendChild(el("div", "err", "could not load state: " + (e.message ?? e)));
  } finally {
    booting = false;
    sendBtn.disabled = false;
  }
})();
`;
