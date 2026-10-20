export const SETTINGS_B_JS = `/* ---------- branch picker (branch-per-prototype flow) ---------- */
let ghBranches = null;
let ghBranchesFailed = false;

/** Drop the cached branch list so the picker refetches for the new link. Pure
 * cache invalidation: branch drafts are repo-scoped separately (ghNoteLinked),
 * so History loads on the same repo keep the picker's input. */
function ghResetBranches() { ghBranches = null; ghBranchesFailed = false; }

/** Branch drafts name branches of one repo: clear them when leaving it. */
function ghClearBranchDrafts() { ghDraft.pickedBranch = ""; ghDraft.delBranch = ""; }

/** Reset branch caches after a link change; drafts reset only when the repo
 * (owner/name) actually changed, so same-repo History loads keep them. */
function ghNoteLinked(prevLink) {
  ghResetBranches();
  const next = ghStatus && ghStatus.linked;
  const same = !!prevLink && !!next &&
    prevLink.owner === next.owner && prevLink.repo === next.repo;
  if (!same) ghClearBranchDrafts();
}

/** Point the status link at a freshly loaded value (History start/list/resume
 * can move it): caches reset, drafts only when the repo actually changed. */
function ghSetLinked(next) {
  const prev = ghStatus && ghStatus.linked;
  if (ghStatus) ghStatus.linked = next || null;
  ghNoteLinked(prev);
}

function ghApplyBranchFiles(r) {
  if (r.files) {
    files = r.files;
    const sorted = Object.keys(files).sort();
    if (!(activeFile in files)) activeFile = sorted[0];
  }
  if (r.built) { built = r.built; setMetrics(built); }
  if (r.linked) {
    if (ghStatus) ghStatus.linked = r.linked;
    updateRepoBadge(r.linked);
  }
}

async function ghLoadBranches() {
  if (!ghStatus || !ghStatus.linked) return;
  ghBusy = true; renderPane();
  try {
    const r = await apiFetch("/api/git/branches", { cache: "no-store" }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    ghBranches = r;
    ghBranchesFailed = false;
    if (r.linked && ghStatus) {
      ghStatus.linked = r.linked;
      updateRepoBadge(r.linked);
    } else if (r.current && ghStatus && ghStatus.linked && ghStatus.linked.branch !== r.current) {
      ghStatus.linked = Object.assign({}, ghStatus.linked, { branch: r.current });
      updateRepoBadge(ghStatus.linked);
    }
    ghMsg = (r.branches || []).length ? "" : "no branches found";
  } catch (e) { ghBranchesFailed = true; ghMsg = "branches failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghNewBranch(name) {
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  let clean = (name || "").trim();
  if (clean.slice(0, 6) === "proto/") clean = clean.slice(6);
  while (clean.charAt(0) === "/") clean = clean.slice(1);
  if (!clean) { ghNote("enter a branch name, e.g. proto/my-prototype"); return; }
  const submitted = name;
  ghBusy = true; ghMsg = "saving files, creating proto/" + clean + " and pushing…"; renderPane();
  try {
    await ghSaveAll();
    const r = await apiFetch("/api/git/branch/new", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "proto/" + clean }),
    }).then((r) => r.json());
    if (r.files) files = r.files;
    if (r.error) throw new Error(r.error);
    ghApplyBranchFiles(r);
    await ghLoadBranchesSilent();
    if (ghDraft.newBranch === submitted) ghDraft.newBranch = "";
    ghDraft.pickedBranch = r.branch;
    ghMsg = "created and pushed " + r.branch + ". " + (r.output || "").slice(0, 500);
  } catch (e) {
    // A failed create can still persist branch changes (a local-only branch
    // after a refused push): refresh first so the picker is not stale.
    await ghLoadBranchesSilent();
    // The checkout may have moved: sync the picker to the refreshed truth.
    if (ghBranches && ghBranches.current) ghDraft.pickedBranch = ghBranches.current;
    ghMsg = "new branch failed: " + (e.message || e);
  }
  ghBusy = false; renderPane();
}

async function ghLoadBranchesSilent() {
  try {
    const r = await apiFetch("/api/git/branches", { cache: "no-store" }).then((r) => r.json());
    if (!r.error) {
      ghBranches = r;
      ghBranchesFailed = false;
      if (r.linked && ghStatus) {
        ghStatus.linked = r.linked;
        updateRepoBadge(r.linked);
      } else if (r.current && ghStatus && ghStatus.linked) {
        ghStatus.linked = Object.assign({}, ghStatus.linked, { branch: r.current });
        updateRepoBadge(ghStatus.linked);
      }
    }
  } catch { /* silent refresh; the message below carries the result */ }
}

async function ghSwitchBranch(branch) {
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  if (!branch) { ghNote("pick a branch first"); return; }
  ghBusy = true; ghMsg = "switching to " + branch + "…"; renderPane();
  try {
    // Save first like Commit/Create: the server replaces the worktree on
    // switch, so unsaved editor edits must be persisted, not overwritten.
    await ghSaveAll();
    const r = await apiFetch("/api/git/branch/switch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch }),
    }).then((r) => r.json());
    if (r.files) files = r.files;
    if (r.error) throw new Error(r.error);
    ghApplyBranchFiles(r);
    await ghLoadBranchesSilent();
    ghDraft.pickedBranch = r.branch;
    ghMsg = "switched to " + r.branch + ". " + (r.output || "").slice(0, 500);
  } catch (e) {
    await ghLoadBranchesSilent();
    if (ghBranches && ghBranches.current) ghDraft.pickedBranch = ghBranches.current;
    ghMsg = "switch failed: " + (e.message || e);
  }
  ghBusy = false; renderPane();
}

async function ghDeleteBranch(branch) {
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  if (!branch) { ghNote("pick a branch first"); return; }
  if (ghIsRemoteOnly(branch)) { ghNote(branch + " is remote-only — switch to (or create) the local branch first"); return; }
  ghBusy = true; ghMsg = "deleting " + branch + " locally and on origin…"; renderPane();
  try {
    // Same save-first rule as switch: the server may rewrite the worktree.
    await ghSaveAll();
    const r = await apiFetch("/api/git/branch/delete", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch }),
    }).then((r) => r.json());
    if (r.files) files = r.files;
    if (r.error) throw new Error(r.error);
    ghApplyBranchFiles(r);
    await ghLoadBranchesSilent();
    // The deleted name must not linger in the picker or the delete field.
    if (ghDraft.pickedBranch === branch) ghDraft.pickedBranch = "";
    ghDraft.delBranch = "";
    ghMsg = "deleted " + branch + " locally and on origin. " + (r.output || "").slice(0, 500);
  } catch (e) {
    // A local-delete/remote-delete split can persist branch changes:
    // refresh first so the picker is not stale.
    await ghLoadBranchesSilent();
    // A partial failure may still have removed the branch locally: drop the
    // drafts only when the name is actually gone.
    const names = ghBranches && Array.isArray(ghBranches.branches)
      ? ghBranches.branches.map((b) => b.name) : [];
    if (!names.includes(branch)) {
      if (ghDraft.pickedBranch === branch) ghDraft.pickedBranch = "";
      ghDraft.delBranch = "";
    } else if (ghBranches && ghBranches.current) {
      ghDraft.pickedBranch = ghBranches.current;
    }
    ghMsg = "delete failed: " + (e.message || e);
  }
  ghBusy = false; renderPane();
}

/** True when the picker selection names a remote-only entry. */
function ghIsRemoteOnly(name) {
  const list = ghBranches && Array.isArray(ghBranches.branches) ? ghBranches.branches : [];
  const entry = list.find((b) => b.name === name);
  return !!entry && entry.remote;
}

function ghBranchOptions(brSel) {
  const cur = ghBranches && ghBranches.current;
  const list = ghBranches && Array.isArray(ghBranches.branches) ? ghBranches.branches : [];
  if (!ghBranches && !ghBranchesFailed) {
    const o = el("option", null, "loading branches…");
    o.value = "";
    brSel.appendChild(o);
    apiFetch("/api/git/branches", { cache: "no-store" }).then((r) => r.json()).then((r) => {
      if (!r.error) {
        ghBranches = r;
        ghBranchesFailed = false;
        if (r.linked && ghStatus) {
          ghStatus.linked = r.linked;
          updateRepoBadge(r.linked);
        } else if (r.current && ghStatus && ghStatus.linked) {
          ghStatus.linked = Object.assign({}, ghStatus.linked, { branch: r.current });
          updateRepoBadge(ghStatus.linked);
        }
        if (brSel.isConnected) renderPane();
      } else {
        ghBranchesFailed = true;
        if (brSel.isConnected) renderPane();
      }
    }).catch(() => {
      ghBranchesFailed = true;
      if (brSel.isConnected) renderPane();
    });
  } else if (ghBranchesFailed) {
    const o = el("option", null, "(branch list unavailable)");
    o.value = "";
    brSel.appendChild(o);
  } else {
    for (const b of list) {
      const label = (b.current ? "● " : "") + b.name + (b.remote && !list.some((x) => x.name === b.name && !x.remote) ? " (remote)" : "");
      const o = el("option", null, label);
      o.value = b.name;
      if (ghDraft.pickedBranch) {
        if (b.name === ghDraft.pickedBranch) o.selected = true;
      } else if (b.current || (!cur && ghStatus && ghStatus.linked && b.name === ghStatus.linked.branch)) o.selected = true;
      brSel.appendChild(o);
    }
    if (!list.length) {
      const o = el("option", null, "(no branches listed)");
      o.value = "";
      brSel.appendChild(o);
    }
  }
}

function renderGhTabs(wrap) {
  const tabs = el("div", "subtabs");
  tabs.setAttribute("role", "tablist");
  const defs = [["general", "General"], ["work", "Work"], ["makerepo", "Make repo"], ["advanced", "Advanced"]];
  const active = ghActiveTab();
  for (const pair of defs) {
    const b = el("button", "subtab", pair[1]);
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", active === pair[0] ? "true" : "false");
    b.onclick = (function (t) { return function () { ghSetTab(t); }; })(pair[0]);
    tabs.appendChild(b);
  }
  wrap.appendChild(tabs);
}

/** API key + gateway: needed by BYOK users with no GitHub dependency, so this
 * renders before the status-gated early return in renderGitHub too. */
function renderGhModelSetup(wrap) {
  wrap.appendChild(el("h2", null, "Model setup"));
  wrap.appendChild(el("p", "hint", "API key stays only in this browser. Gateway picks the chat backend; the model is picked in the composer."));
  const krow = el("div", "row");
  const keyInput = document.createElement("input");
  keyInput.id = "apikey";
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.spellcheck = false;
  keyInput.placeholder = "API key (stored only in this browser)";
  keyInput.setAttribute("aria-label", "Model API key");
  keyInput.value = localStorage.getItem("ab_key") || "";
  keyInput.oninput = () => localStorage.setItem("ab_key", keyInput.value.trim());
  krow.appendChild(keyInput);
  wrap.appendChild(krow);
  const grow = el("div", "row");
  const gwLabel = el("span", "hint", "gateway");
  const gwSel = document.createElement("select");
  gwSel.id = "gateway";
  gwSel.title = "Gateway";
  gwSel.setAttribute("aria-label", "Gateway");
  for (const g of Object.keys(GATEWAYS)) {
    const o = document.createElement("option");
    o.value = g; o.textContent = g;
    gwSel.appendChild(o);
  }
  gwSel.value = getGateway();
  gwSel.onchange = () => setGateway(gwSel.value);
  grow.appendChild(gwLabel);
  grow.appendChild(gwSel);
  wrap.appendChild(grow);
}

function renderGhGeneral(wrap) {
  renderGhModelSetup(wrap);
  wrap.appendChild(el("h2", null, "GitHub account"));
  if (!ghStatus.connected) {
    const row = el("div", "row");
    const b = el("button", "primary", ghBusy ? "…" : "Log in with GitHub");
    b.disabled = ghBusy;
    b.onclick = () => { window.location.href = "/api/github/login"; };
    row.appendChild(b);
    row.appendChild(el("span", "hint", "OAuth; token stays server-side."));
    wrap.appendChild(row);
  } else {
    const who = el("div", "row");
    who.appendChild(el("span", null, "connected as " + (ghStatus.user ? ghStatus.user.login : "?")));
    const scopes = Array.isArray(ghStatus.scopes) ? ghStatus.scopes : [];
    if (scopes.length && !scopes.includes("workflow")) {
      who.appendChild(el("span", "hint", "missing workflow scope — Log out and back in, or pushes touching .github/workflows/* will 403"));
    }
    if (ghStatus.tokenKind && ghStatus.tokenKind !== "oauth") {
      who.appendChild(el("span", "hint", "token type: " + ghStatus.tokenKind + " — pushes need an OAuth-App login"));
    }
    if (ghStatus.tokenKind === "github-app") {
      who.appendChild(el("span", "hint", "GitHub-App login: API works but every git push is refused. Use an OAuth App instead, then Log out and back in."));
    }
    const out = el("button", null, "Log out");
    out.onclick = async () => {
      await apiFetch("/api/github/logout", { method: "POST" });
      ghStatus = null; ghRepos = [];
      ghResetBranches();
      await ghRefreshStatus();
      if (ghStatus && ghStatus.connected) {
        authed = true; syncGateTabs(); renderPane();
      } else {
        showGate();
      }
    };
    who.appendChild(out);
    wrap.appendChild(who);
    const det = document.createElement("details");
    det.className = "tok";
    const sum = document.createElement("summary");
    sum.textContent = "token details";
    det.appendChild(sum);
    const granted = Array.isArray(ghStatus.grantedScopes) ? ghStatus.grantedScopes : [];
    det.appendChild(el("p", "hint", "scopes now: " + (scopes.length ? scopes.join(", ") : "unknown")));
    if (granted.length) det.appendChild(el("p", "hint", "granted at login: " + granted.join(", ")));
    wrap.appendChild(det);
  }
  renderSharing(wrap);
}

function renderGhWork(wrap, linked) {
  wrap.appendChild(el("p", "hint",
    linked ? ("linked: " + linked.owner + "/" + linked.repo + " (" + linked.branch + ")") : "no repo linked yet"));
  const openCard = el("div", "card");
  openCard.appendChild(el("h3", null, "Open a repo"));
  openCard.appendChild(el("p", "hint", "Clone something you own to edit it here, or pick from your repos below."));
  const orow = el("div", "row");
  const ref = document.createElement("input");
  ref.type = "text"; ref.placeholder = "owner/repo";
  ref.setAttribute("aria-label", "Repo owner slash name");
  ref.value = ghDraft.openRef || "";
  ref.oninput = () => { ghDraft.openRef = ref.value; };
  const br = document.createElement("input");
  br.type = "text"; br.placeholder = "branch (optional)"; br.style.minWidth = "130px";
  br.setAttribute("aria-label", "Branch (optional)");
  br.value = ghDraft.openBranch || "";
  br.oninput = () => { ghDraft.openBranch = br.value; };
  const openBtn = el("button", "primary", "Open repo");
  openBtn.disabled = ghBusy;
  openBtn.onclick = () => ghOpen(ref.value, br.value || undefined);
  orow.appendChild(ref); orow.appendChild(br); orow.appendChild(openBtn);
  openCard.appendChild(orow);
  const lrow = el("div", "row");
  const lb = el("button", null, ghRepos.length ? "Refresh my repos" : "List my repos");
  lb.disabled = ghBusy;
  lb.onclick = ghLoadRepos;
  lrow.appendChild(lb);
  openCard.appendChild(lrow);
  for (const r of ghRepos.slice(0, 20)) {
    const d = el("div", "repo", (r.private ? "🔒 " : "") + r.fullName);
    d.onclick = () => ghOpen(r.fullName, undefined);
    openCard.appendChild(d);
  }
  wrap.appendChild(openCard);
  if (linked) {
    const brCard = el("div", "card");
    brCard.appendChild(el("h3", null, "Branches"));
    brCard.appendChild(el("p", "hint", "One branch = one prototype. Create proto/<name> from HEAD, then switch between them."));
    const brow = el("div", "row");
    const brSel = document.createElement("select");
    brSel.title = "Pick a branch";
    brSel.setAttribute("aria-label", "Pick a branch");
    brSel.style.minWidth = "170px";
    ghBranchOptions(brSel);
    if (!ghDraft.pickedBranch && brSel.options.length) ghDraft.pickedBranch = brSel.value;
    brSel.onchange = () => { ghDraft.pickedBranch = brSel.value; };
    const cur = ghBranches && ghBranches.current;
    const curLbl = el("span", "hint", cur ? ("on " + cur) : ("on " + linked.branch));
    const swBtn = el("button", null, "Switch");
    swBtn.disabled = ghBusy;
    swBtn.title = "Checkout the selected branch";
    swBtn.onclick = () => ghSwitchBranch(brSel.value || (cur || ""));
    const refBtn = el("button", null, "Refresh branches");
    refBtn.disabled = ghBusy;
    refBtn.title = "Refresh branch list";
    refBtn.onclick = ghLoadBranches;
    brow.appendChild(brSel); brow.appendChild(swBtn); brow.appendChild(refBtn); brow.appendChild(curLbl);
    brCard.appendChild(brow);
    const nrow = el("div", "row");
    const protoPrefix = el("span", "hint", "proto/");
    const nmBr = document.createElement("input");
    nmBr.type = "text"; nmBr.placeholder = "my-prototype"; nmBr.style.minWidth = "150px";
    nmBr.setAttribute("aria-label", "New branch name");
    nmBr.value = ghDraft.newBranch || "";
    nmBr.oninput = () => { ghDraft.newBranch = nmBr.value; };
    const newBtn = el("button", "primary", "New branch + push");
    newBtn.disabled = ghBusy;
    newBtn.title = "Create proto/<name> from HEAD and push -u origin";
    newBtn.onclick = () => ghNewBranch(nmBr.value);
    nrow.appendChild(protoPrefix); nrow.appendChild(nmBr); nrow.appendChild(newBtn);
    brCard.appendChild(nrow);
    wrap.appendChild(brCard);
  }
  const saveCard = el("div", "card");
  saveCard.appendChild(el("h3", null, "Save your work"));
  saveCard.appendChild(el("p", "hint", "Commit pushes the current files to the linked branch."));
  const mrow = el("div", "row");
  const msg = document.createElement("input");
  msg.type = "text"; msg.placeholder = "commit message";
  msg.setAttribute("aria-label", "Commit message");
  msg.value = ghDraft.commitMsg || "";
  msg.oninput = () => { ghDraft.commitMsg = msg.value; };
  const pushBtn = el("button", "primary", "Commit + push");
  pushBtn.disabled = ghBusy;
  pushBtn.onclick = () => ghCommitPush(msg.value);
  const pullBtn = el("button", null, "Pull");
  pullBtn.disabled = ghBusy;
  pullBtn.onclick = ghPull;
  mrow.appendChild(msg); mrow.appendChild(pushBtn); mrow.appendChild(pullBtn);
  saveCard.appendChild(mrow);
  const qrow = el("div", "row");
  const items = [["status", "Status"], ["log", "Log"]];
  for (const pair of items) {
    const b = el("button", null, pair[1]);
    b.disabled = ghBusy;
    b.onclick = ((w) => () => ghShow(w))(pair[0]);
    qrow.appendChild(b);
  }
  saveCard.appendChild(qrow);
  wrap.appendChild(saveCard);
}

function renderGhMakeRepo(wrap, linked) {
  wrap.appendChild(el("p", "hint",
    linked ? ("linked: " + linked.owner + "/" + linked.repo + " (" + linked.branch + ")") : "no repo linked yet"));
  const c1 = el("div", "card");
  c1.appendChild(el("h3", null, "New repo from current files"));
  c1.appendChild(el("p", "hint", "Start a fresh repo from what is on screen now. Single squashed commit."));
  const crow = el("div", "row");
  const nm = document.createElement("input");
  nm.type = "text"; nm.placeholder = "new repo name";
  nm.setAttribute("aria-label", "New repo name");
  nm.value = ghDraft.createName || "";
  nm.oninput = () => { ghDraft.createName = nm.value; };
  const privLbl = document.createElement("label");
  privLbl.className = "check";
  const priv = document.createElement("input");
  priv.type = "checkbox"; priv.title = "private";
  priv.checked = !!ghDraft.createPrivate;
  priv.onchange = () => { ghDraft.createPrivate = priv.checked; };
  privLbl.appendChild(priv);
  privLbl.appendChild(document.createTextNode("private"));
  const createBtn = el("button", "primary", "Create + push");
  createBtn.disabled = ghBusy;
  createBtn.onclick = () => ghCreate(nm.value.trim(), priv.checked, "initial commit from app-builder");
  crow.appendChild(nm); crow.appendChild(privLbl); crow.appendChild(createBtn);
  c1.appendChild(crow);
  wrap.appendChild(c1);
  const c2 = el("div", "card");
  c2.appendChild(el("h3", null, "New repo from this branch (keep history)"));
  c2.appendChild(el("p", "hint", "Graduate the linked branch to its own repo with full commit history."));
  const prow = el("div", "row");
  const pm = document.createElement("input");
  pm.type = "text"; pm.placeholder = "new repo name";
  pm.setAttribute("aria-label", "Promoted repo name");
  pm.value = ghDraft.promoteName || "";
  pm.oninput = () => { ghDraft.promoteName = pm.value; };
  const pprivLbl = document.createElement("label");
  pprivLbl.className = "check";
  const ppriv = document.createElement("input");
  ppriv.type = "checkbox"; ppriv.title = "private";
  ppriv.checked = !!ghDraft.promotePrivate;
  ppriv.onchange = () => { ghDraft.promotePrivate = ppriv.checked; };
  pprivLbl.appendChild(ppriv);
  pprivLbl.appendChild(document.createTextNode("private"));
  prow.appendChild(pm); prow.appendChild(pprivLbl);
  c2.appendChild(prow);
  const orow2 = el("div", "row");
  const pdelLbl = document.createElement("label");
  pdelLbl.className = "check";
  const pdel = document.createElement("input");
  pdel.type = "checkbox"; pdel.title = "delete source branch after promote";
  pdel.checked = !!ghDraft.promoteDel;
  pdel.onchange = () => { ghDraft.promoteDel = pdel.checked; };
  pdelLbl.appendChild(pdel);
  pdelLbl.appendChild(document.createTextNode("delete source branch"));
  const pincLbl = document.createElement("label");
  pincLbl.className = "check";
  const pinc = document.createElement("input");
  pinc.type = "checkbox"; pinc.title = "include uncommitted changes as uncommitted in the new repo";
  pinc.checked = !!ghDraft.promoteInc;
  pinc.onchange = () => { ghDraft.promoteInc = pinc.checked; };
  pincLbl.appendChild(pinc);
  pincLbl.appendChild(document.createTextNode("include uncommitted"));
  orow2.appendChild(pdelLbl); orow2.appendChild(pincLbl);
  c2.appendChild(orow2);
  const brow3 = el("div", "row");
  const promoteBtn = el("button", "primary", "Promote branch to new repo");
  promoteBtn.disabled = ghBusy || !linked;
  promoteBtn.title = linked ? "Create the new repo from this branch, keeping history" : "Open a repo first, then promote its branch";
  promoteBtn.onclick = () => ghPromote(pm.value.trim(), ppriv.checked, pdel.checked, pinc.checked);
  brow3.appendChild(promoteBtn);
  c2.appendChild(brow3);
  wrap.appendChild(c2);
}

function renderGhAdvanced(wrap, linked) {
  wrap.appendChild(el("p", "hint", "Rarely needed. These can rewrite history or run raw git — double-check before using."));
  const dCard = el("div", "card");
  dCard.appendChild(el("h3", null, "Delete a branch"));
  dCard.appendChild(el("p", "hint", "Removes a merged proto/* branch locally and on origin. Unmerged deletes stay explicit: git branch -D <name>. Remote-only branch entries (origin/*) cannot be deleted here — switch to (or create) the local branch first."));
  const drow = el("div", "row");
  const din = document.createElement("input");
  din.type = "text"; din.placeholder = "branch, e.g. proto/my-prototype";
  din.setAttribute("aria-label", "Branch to delete");
  din.value = ghDraft.delBranch || (ghDraft.pickedBranch || "");
  const delBtn = el("button", null, "Delete branch");
  delBtn.title = "Delete the branch locally and on origin";
  const syncDelBtn = () => {
    delBtn.disabled = ghBusy || !linked || !(din.value || "").trim();
  };
  syncDelBtn();
  din.oninput = () => { ghDraft.delBranch = din.value; syncDelBtn(); };
  delBtn.onclick = () => ghDeleteBranch((din.value || "").trim());
  drow.appendChild(din); drow.appendChild(delBtn);
  dCard.appendChild(drow);
  wrap.appendChild(dCard);
  const gCard = el("div", "card");
  gCard.appendChild(el("h3", null, "Run raw git"));
  gCard.appendChild(el("p", "hint", "Read-only commands like status, log, diff --stat are safest. Mutating commands run for real."));
  const qrow = el("div", "row");
  const cmd = document.createElement("input");
  cmd.type = "text"; cmd.placeholder = "git args, e.g. diff --stat";
  cmd.setAttribute("aria-label", "Git args");
  cmd.value = ghDraft.runCmd || "";
  cmd.oninput = () => { ghDraft.runCmd = cmd.value; };
  const runB = el("button", null, "Run git");
  runB.disabled = ghBusy;
  runB.onclick = () => ghRunCmd(cmd.value);
  qrow.appendChild(cmd); qrow.appendChild(runB);
  gCard.appendChild(qrow);
  wrap.appendChild(gCard);
}

function renderGitHub() {
  const wrap = el("div");
  wrap.id = "gh";
  wrap.appendChild(el("h2", null, "Settings"));
  renderGhTabs(wrap);
  const tab = ghActiveTab();
  if (!ghStatus) {
    // Model setup has no GitHub dependency, so BYOK users get their key field
    // even while status is loading or failed (as before the sub-tab split).
    renderGhModelSetup(wrap);
    if (ghStatusFailed) {
      wrap.appendChild(el("p", "hint", "GitHub status is unavailable."));
      const retry = el("button", null, "Retry");
      retry.onclick = () => { ghRefreshStatus().then(renderPane); };
      const row = el("div", "row");
      row.appendChild(retry);
      wrap.appendChild(row);
    } else {
      wrap.appendChild(el("p", "hint", "loading…"));
      ghRefreshStatus().then(renderPane);
    }
    if (tab === "general") renderSharing(wrap);
    if (ghMsg) wrap.appendChild(el("pre", "out", ghMsg));
    pane.appendChild(wrap);
    return;
  }
  if (!ghStatus.connected && tab !== "general") {
    wrap.appendChild(el("p", "hint", "Log in with GitHub on the General tab first — then this tab unlocks."));
    const go = el("button", null, "Go to General");
    go.onclick = () => ghSetTab("general");
    const row = el("div", "row");
    row.appendChild(go);
    wrap.appendChild(row);
    if (ghMsg) wrap.appendChild(el("pre", "out", ghMsg));
    pane.appendChild(wrap);
    return;
  }
  const linked = ghStatus.linked;
  if (tab === "general") renderGhGeneral(wrap);
  else if (tab === "work") renderGhWork(wrap, linked);
  else if (tab === "makerepo") renderGhMakeRepo(wrap, linked);
  else renderGhAdvanced(wrap, linked);
  if (ghMsg) {
    const pre = el("pre", "out", ghMsg);
    wrap.appendChild(pre);
  }
  pane.appendChild(wrap);
}


function setMetrics(b) {
  if (b && b.ok) appV++;
  mBundle.textContent = b && b.durationMs != null ? b.durationMs + " ms" : "—";
  // Without a capsule there is nothing to build: a red "failed" would blame
  // a static repo for not being a capsule, so show a neutral label instead.
  if (!hasCapsuleFiles()) { mBuilt.textContent = "no capsule"; mBuilt.className = ""; return; }
  if (!b) { mBuilt.textContent = "idle"; mBuilt.className = "built"; return; }
  const bad = !b.ok;
  const n = (b.diagnostics || []).length;
  mBuilt.textContent = bad ? "failed" : n ? \`built · \${n} type error\${n === 1 ? "" : "s"}\` : "built";
  mBuilt.className = bad ? "failed" : "built";
}

/* Type errors ride along on the build result without blocking it (see
   session.build), so they render as their own strip in the Code view —
   where the user can act on them — using textContent throughout so
   diagnostic text quoting user code can never become markup. */
function diagBanner() {
  const diags = (built && built.diagnostics) || [];
  const failure = built && built.typecheckFailure;
  if (!diags.length && !failure) return null;
  const d = el("div");
  d.className = "diag";
  const lines = diags.map((g) => \`\${g.file}(\${g.line},\${g.column}): \${g.category}\${g.code ? \` TS\${g.code}\` : ""}: \${g.text}\`);
  if (failure) lines.push(\`type checker did not finish (\${failure.name}): \${failure.message}\`);
  d.appendChild(el("b", null, diags.length
    ? \`\${diags.length} type error\${diags.length === 1 ? "" : "s"} — the app preview still runs; lint blocks deploy until these are fixed\`
    : "type checker did not finish"));
  d.appendChild(document.createTextNode("\\n" + lines.join("\\n")));
  return d;
}

`;
