export const SETTINGS_A_JS = `/* ---------- github panel (just-git, server-side) ---------- */
let ghStatus = null;
let ghRepos = [];
let ghMsg = "";
let ghBusy = false;
let ghStatusFailed = false;
// Settings sub-tabs: General | Work | Make repo | Advanced. Persisted so a
// reload lands back on the same workflow; defaults to Work once logged in.
let ghTab = "";
try { ghTab = localStorage.getItem("ab_gh_tab") || ""; } catch { ghTab = ""; }
// Draft inputs live here so switching sub-tabs (which re-renders) does not
// wipe what was already typed — previously every renderPane() reset them.
let ghDraft = {
  openRef: "", openBranch: "", newBranch: "",
  createName: "", createPrivate: false,
  promoteName: "", promotePrivate: false, promoteDel: false, promoteInc: false,
  commitMsg: "", runCmd: "", delBranch: "", inviteCode: "",
};
function ghActiveTab() {
  if (ghTab === "general" || ghTab === "work" || ghTab === "makerepo" || ghTab === "advanced") return ghTab;
  return (ghStatus && ghStatus.connected) ? "work" : "general";
}
function ghSetTab(t) {
  ghTab = t;
  try { localStorage.setItem("ab_gh_tab", t); } catch { /* private mode: tab just won't persist */ }
  renderPane();
}

async function ghRefreshStatus() {
  try {
    ghStatus = await fetch("/api/github/status", { cache: "no-store" }).then((r) => r.json());
    ghStatusFailed = false;
  } catch (e) {
    ghStatusFailed = true;
    ghMsg = "could not reach github status: " + (e.message || e);
  }
}

/* ---------- live sharing (issue #30): two members, one playground ---------- */
let shStatus = null;
let shMsg = "";
let shBusy = false;
let shLoaded = false;
/** Whole-FileMap version from /api/state; saves send it back as baseVersion. */
let filesVersion = 0;

async function shRefresh() {
  try {
    shStatus = await apiFetch("/api/share/status", { cache: "no-store" }).then((r) => r.json());
    shLoaded = true;
  } catch (e) {
    shMsg = "could not reach sharing status: " + (e.message || e);
  }
}

async function shInvite() {
  if (shBusy) return;
  shBusy = true; shMsg = "creating invite…"; renderPane();
  try {
    const r = await apiFetch("/api/share/invite", { method: "POST" }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    const link = location.origin + "/?invite=" + encodeURIComponent(r.playgroundId + "." + r.code);
    try {
      await navigator.clipboard.writeText(link);
      shMsg = "invite link copied (expires in 24h). They join as themselves — your login and token are never shared.";
    } catch {
      shMsg = "invite link (expires in 24h): " + link;
    }
    await shRefresh();
  } catch (e) { shMsg = "invite failed: " + (e.message || e); }
  shBusy = false; renderPane();
}

async function shJoin(code) {
  code = (code || "").trim();
  if (!code) { shMsg = "paste an invite code first"; renderPane(); return; }
  if (shBusy) return;
  shBusy = true; shMsg = "joining…"; renderPane();
  try {
    const r = await apiFetch("/api/share/join", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    // Cookies now name the shared playground: reload into it.
    location.href = "/";
  } catch (e) { shMsg = "join failed: " + (e.message || e); }
  shBusy = false; renderPane();
}

async function shLeave() {
  if (shBusy) return;
  shBusy = true; shMsg = "leaving…"; renderPane();
  try {
    const r = await apiFetch("/api/share/leave", { method: "POST" }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    location.href = "/";
  } catch (e) { shMsg = "leave failed: " + (e.message || e); }
  shBusy = false; renderPane();
}

/** Sharing section of the GitHub tab: invite/join, roster, turn, audit. */
function renderSharing(wrap) {
  wrap.appendChild(el("h2", null, "Sharing"));
  if (!shLoaded) {
    if (!shStatus) {
      wrap.appendChild(el("p", "hint", "loading sharing…"));
      shRefresh().then(renderPane);
    }
    if (shMsg) wrap.appendChild(el("pre", "out", shMsg));
    return;
  }
  if (!shStatus.shared) {
    wrap.appendChild(el("p", "hint",
      "This playground is private to you. To work together live, invite one teammate by link: " +
      "they join as themselves with their own GitHub login — your cookie and your token are never shared. " +
      "Pushes are attributed to whoever pushes; a member without write access gets the collaborator error, not your token."));
    const row = el("div", "row");
    const b = el("button", "primary", shBusy ? "…" : "Invite teammate");
    b.disabled = shBusy || !(ghStatus && ghStatus.connected);
    b.title = ghStatus && ghStatus.connected ? "Create a 24h invite link" : "Log in with GitHub first";
    b.onclick = shInvite;
    row.appendChild(b);
    wrap.appendChild(row);
  } else {
    const members = Array.isArray(shStatus.members) ? shStatus.members : [];
    const names = members.map((m) => (m.login || "pending invite") + " (" + m.role + ")").join(", ") || "—";
    wrap.appendChild(el("p", "hint", "Shared playground — live files, chat, and preview for: " + names));
    const turn = shStatus.turn || {};
    wrap.appendChild(el("p", "hint", turn.active
      ? "Agent turn running" + (turn.actor ? " (" + turn.actor + ")" : "") + (turn.queued ? " — " + turn.queued + " queued" : " — new turns queue behind it")
      : "Agent idle — either member can drive the next turn."));
    wrap.appendChild(el("p", "hint", "Files version " + (shStatus.filesVersion ?? "?") + " — if your save says a teammate edited first, reload: their files are adopted, nothing is silently overwritten."));
    const audit = Array.isArray(shStatus.audit) ? shStatus.audit.slice(0, 8) : [];
    if (audit.length) {
      wrap.appendChild(el("p", "hint", "Recent: " + audit.map((a) =>
        a.actor + " " + a.action + (a.detail ? " " + a.detail : "")).join(" · ").slice(0, 400)));
    }
    // Only the owner may invite (the endpoint 403s otherwise, and status
    // only carries the code for the owner): members get leave, not rotate.
    const isOwner = !!(shStatus.owner && shStatus.owner.login && ghStatus && ghStatus.user &&
      shStatus.owner.login === ghStatus.user.login);
    const row = el("div", "row");
    if (isOwner) {
      const copy = el("button", null, shBusy ? "…" : "Copy invite link");
      copy.disabled = shBusy;
      copy.onclick = shInvite;
      copy.title = "Create a fresh 24h invite link (rotates the previous one)";
      row.appendChild(copy);
    } else if (shStatus.invite) {
      wrap.appendChild(el("p", "hint", "Invite rotation is owner-only — ask " + shStatus.owner.login + " for a fresh link."));
    }
    const leave = el("button", null, "Leave playground");
    leave.disabled = shBusy;
    leave.onclick = shLeave;
    row.appendChild(leave);
    wrap.appendChild(row);
  }
  const jrow = el("div", "row");
  const code = document.createElement("input");
  code.type = "text";
  code.placeholder = "paste invite code to join";
  code.setAttribute("aria-label", "Invite code");
  code.value = ghDraft.inviteCode || "";
  code.oninput = () => { ghDraft.inviteCode = code.value; };
  const join = el("button", null, "Join playground");
  join.disabled = shBusy;
  join.onclick = () => shJoin(code.value);
  jrow.appendChild(code);
  jrow.appendChild(join);
  wrap.appendChild(jrow);
  if (shMsg) wrap.appendChild(el("pre", "out", shMsg));
}

/** Persist the editor's in-memory files before a commit/create, so unsaved
 * browser edits are not silently omitted from the push. Sends the version the
 * editor rendered from: a teammate persisting first 409s, and we adopt the
 * server files (reload prompt) instead of silently overwriting them. */
async function ghSaveAll() {
  const r = await apiFetch("/api/files", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ files, baseVersion: filesVersion }),
  }).then((r) => r.json());
  if (r.error && r.files) {
    files = r.files;
    if (typeof r.version === "number") filesVersion = r.version;
    renderPane();
  }
  if (r.error) throw new Error("save failed: " + r.error);
  files = r.files || files;
  if (typeof r.version === "number") filesVersion = r.version;
}

async function ghLoadRepos() {
  ghBusy = true; renderPane();
  try {
    const r = await apiFetch("/api/github/repos").then((r) => r.json());
    if (r.error) ghMsg = r.error;
    else { ghRepos = r.repos || []; ghMsg = ghRepos.length ? "" : "no repos found"; }
  } catch (e) { ghMsg = "repo list failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

function ghNote(t) { ghMsg = t; renderPane(); }

async function ghOpen(ref, branch) {
  ghBusy = true; ghMsg = "cloning " + ref + "…"; renderPane();
  try {
    const r = await apiFetch("/api/github/open", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref, branch }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    files = r.files || files;
    const sorted = Object.keys(files).sort();
    activeFile = activeFile in files ? activeFile : sorted[0];
    built = r.built;
    setMetrics(built);
    const prevLink = ghStatus && ghStatus.linked;
    await ghRefreshStatus();
    updateRepoBadge(ghStatus && ghStatus.linked);
    ghNoteLinked(prevLink);
    ghMsg = "opened " + ref + (r.skipped && r.skipped.length ? " (skipped: " + r.skipped.join(", ") + ")" : "") +
      (r.kept ? " (" + r.kept + " local file(s) kept as uncommitted changes — check status/diff, then commit)" : "") +
      ". Nothing to preview? Edit files in Code, then commit below.";
  } catch (e) { ghMsg = "open failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghCreate(name, isPrivate, message) {
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  // Inputs stay editable while the request is in flight: only consume the
  // drafts when they still hold what was submitted.
  const submittedName = name, submittedPrivate = isPrivate;
  ghBusy = true; ghMsg = "saving files, creating " + name + " and pushing…"; renderPane();
  try {
    await ghSaveAll();
    const r = await apiFetch("/api/github/create", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, private: isPrivate, message }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    const prevLink = ghStatus && ghStatus.linked;
    await ghRefreshStatus();
    updateRepoBadge(ghStatus && ghStatus.linked);
    ghNoteLinked(prevLink);
    if (ghDraft.createName === submittedName) ghDraft.createName = "";
    if (ghDraft.createPrivate === submittedPrivate) ghDraft.createPrivate = false;
    ghMsg = "created " + r.repo.fullName + " and pushed. " + (r.output || "").slice(0, 300);
  } catch (e) { ghMsg = "create failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghPromote(name, isPrivate, deleteSourceBranch, includeUncommitted) {
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  if (!ghStatus || !ghStatus.linked) { ghNote("open a repo first, then promote its branch"); return; }
  const submittedName = name, submittedPrivate = isPrivate;
  const submittedDel = deleteSourceBranch, submittedInc = includeUncommitted;
  ghBusy = true; ghMsg = "saving files, creating " + name + " and promoting the branch (history kept)…"; renderPane();
  try {
    await ghSaveAll();
    const r = await apiFetch("/api/github/promote", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, private: isPrivate, deleteSourceBranch, includeUncommitted }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    if (r.files) {
      files = r.files;
      const sorted = Object.keys(files).sort();
      if (!(activeFile in files)) activeFile = sorted[0];
    }
    const prevLink = ghStatus && ghStatus.linked;
    await ghRefreshStatus();
    updateRepoBadge(ghStatus && ghStatus.linked);
    // The linked repo just changed to the new one: branch caches and drafts
    // from the old repo no longer apply.
    ghNoteLinked(prevLink);
    if (ghDraft.promoteName === submittedName) ghDraft.promoteName = "";
    if (ghDraft.promotePrivate === submittedPrivate) ghDraft.promotePrivate = false;
    if (ghDraft.promoteDel === submittedDel) ghDraft.promoteDel = false;
    if (ghDraft.promoteInc === submittedInc) ghDraft.promoteInc = false;
    ghMsg = "promoted to " + r.repo.fullName + " with history" +
      (r.deletedSource ? " (source branch deleted)." : " (source branch left intact).") +
      " " + (r.output || "").slice(0, 300);
  } catch (e) { ghMsg = "promote failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghCommitPush(message) {
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  const submitted = message;
  ghBusy = true; ghMsg = "saving files, committing and pushing…"; renderPane();
  try {
    await ghSaveAll();
    const r = await apiFetch("/api/git/commit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    if (ghDraft.commitMsg === submitted) ghDraft.commitMsg = "";
    ghMsg = "pushed. " + (r.output || "").slice(0, 500);
  } catch (e) { ghMsg = "push failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghPull() {
  ghBusy = true; ghMsg = "pulling…"; renderPane();
  try {
    const r = await apiFetch("/api/git/pull", { method: "POST" }).then((r) => r.json());
    // A 409 conflict still carries the conflict-marked files: always apply
    // them so the editor receives the markers it is told to resolve.
    if (r.files) {
      files = r.files;
      const sorted = Object.keys(files).sort();
      if (!(activeFile in files)) activeFile = sorted[0];
    }
    if (r.built) { built = r.built; setMetrics(built); }
    if (r.error) throw new Error(r.error);
    ghMsg = "pulled. " + (r.output || "").slice(0, 500);
  } catch (e) { ghMsg = "pull failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghShow(which) {
  ghBusy = true; renderPane();
  try {
    const r = await apiFetch("/api/git/" + which, { cache: "no-store" }).then((r) => r.json());
    ghMsg = (which === "status" ? (r.status || r.error) : (r.log || r.error)) || "(empty)";
  } catch (e) { ghMsg = which + " failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghRunCmd(cmd) {
  ghBusy = true; ghMsg = "running git " + cmd + "…"; renderPane();
  try {
    const r = await apiFetch("/api/git/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: cmd }),
    }).then((r) => r.json());
    // Adopt server files even on error: a timed-out op may still complete
    // server-side, and the next Commit/Create must not overwrite its
    // working-tree changes with this panel's stale copy.
    if (r.files) files = r.files;
    if (r.error) throw new Error(r.error);
    if (r.built) { built = r.built; setMetrics(built); }
    ghMsg = "$ git " + cmd + "\\n" + ((r.stdout || "") + "\\n" + (r.stderr || "")).trim().slice(0, 2000) || "(no output)";
  } catch (e) { ghMsg = "git run failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

`;
