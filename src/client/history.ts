export const HISTORY_JS = `/* ---------- session history: named checkpoints of chat + files ---------- */
const repoBadge = document.getElementById("repobadge");
/** Short label for a linked/snapshot repo, or "no repo". */
function repoLabel(r) {
  return r && r.owner && r.repo ? (r.owner + "/" + r.repo + "@" + (r.branch || "main")) : "no repo";
}
/** Chat header icon reflecting the currently linked repo (tap opens Settings). */
function updateRepoBadge(linked) {
  if (!repoBadge) return;
  repoBadge.textContent = "⎇";
  const has = !!(linked && linked.owner);
  repoBadge.title = has
    ? ("Linked repo: " + repoLabel(linked) + " — tap to open Settings")
    : "No repo linked — tap to open Settings";
  repoBadge.setAttribute("aria-label", repoBadge.title);
  repoBadge.className = has ? "linked" : "none";
}
if (repoBadge) {
  repoBadge.onclick = () => { view = "github"; syncTabs(); renderPane(); };
}
async function loadChats() {
  // History lives in its own top-level tab: the panel is rendered into the
  // pane on each visit, so there is no embedded collapsible to toggle.
  const historyPanel = document.getElementById("history");
  if (!historyPanel) return;
  // Action failures must surface where the user is looking: the Chat
  // transcript is hidden while this tab is active, so errors go to the
  // panel itself.
  function historyError(text) {
    const n = el("div", "msg err", text);
    historyPanel.appendChild(n);
    n.scrollIntoView();
  }
  historyPanel.innerHTML = "";
  historyPanel.appendChild(el("div", "hhead", "Chat history"));
  // Start a new chat bound to a repo: dropdown (List my repos fills it) plus
  // a free-form owner/repo input, then POST /api/chats/start. The branch
  // picker lists remote branches for the selected repo so prototypes start
  // on the right branch without typing it.
  const prow = el("div", "hrow");
  const pick = document.createElement("select");
  pick.title = "Pick a repo for the new chat";
  const none = el("option", null, "(no repo — fresh chat)");
  none.value = "";
  pick.appendChild(none);
  const refIn = document.createElement("input");
  refIn.placeholder = "owner/repo (optional)";
  const brIn = document.createElement("input");
  brIn.placeholder = "branch";
  brIn.style.maxWidth = "90px";
  brIn.title = "Branch to open (optional — defaults to the repo default)";
  brIn.setAttribute("aria-label", "Branch to open");
  const brPick = document.createElement("select");
  brPick.title = "Pick a remote branch for the new chat";
  brPick.setAttribute("aria-label", "Pick a remote branch");
  brPick.style.maxWidth = "130px";
  async function loadNewChatBranches() {
    const sel = pick.value && pick.value.includes("/") ? pick.value : "";
    const ref = (refIn.value.trim() || sel || "");
    brPick.innerHTML = "";
    const any = el("option", null, "(default branch)");
    any.value = "";
    brPick.appendChild(any);
    if (!ref.includes("/")) return;
    try {
      const r = await apiFetch("/api/github/branches?ref=" + encodeURIComponent(ref), { cache: "no-store" }).then((r) => r.json());
      // Stale-response guard: the selection may have moved on while this
      // request was in flight — an older list must not overwrite the new one.
      const nowSel = pick.value && pick.value.includes("/") ? pick.value : "";
      const nowRef = (refIn.value.trim() || nowSel || "");
      if (nowRef !== ref) return;
      if (r.error || !Array.isArray(r.branches)) return;
      for (const b of r.branches.slice(0, 100)) {
        const o = el("option", null, b);
        o.value = b;
        brPick.appendChild(o);
      }
      if (r.defaultBranch) brPick.title = "Default branch: " + r.defaultBranch + " — pick a remote branch for the new chat";
    } catch { /* branch list is best-effort; the input still works */ }
  }
  pick.onchange = loadNewChatBranches;
  refIn.onchange = loadNewChatBranches;
  brPick.onchange = () => { brIn.value = brPick.value; };
  const stTitle = document.createElement("input");
  stTitle.placeholder = "save current as… (optional)";
  const start = el("button", "primary", "Start new chat");
  start.onclick = async () => {
    start.disabled = true;
    try {
      const sel = pick.value && pick.value.includes("/") ? pick.value : "";
      const ref = (refIn.value.trim() || sel || null);
      const r = await apiFetch("/api/chats/start", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoRef: ref, branch: brIn.value.trim() || undefined, title: stTitle.value }),
      }).then((r) => r.json());
      if (r.error) throw new Error(r.error);
      files = r.files || files;
      const sorted = Object.keys(files).sort();
      if (!(activeFile in files) && sorted[0]) activeFile = sorted[0];
      built = r.built;
      setMetrics(built);
      renderHistory([]);
      updateRepoBadge(r.linked || null);
      ghSetLinked(r.linked || null);
      // History is its own tab now: return to Chat so the fresh
      // transcript is visible.
      view = "chat";
      syncTabs();
      renderPane();
      log.appendChild(el("div", "msg thinking",
        ref ? ("Started a fresh chat on " + ref + ".") : "Started a fresh chat (no repo)."));
      scroll();
    } catch (e) {
      historyError("start failed: " + (e.message ?? e));
    } finally {
      start.disabled = false;
    }
  };
  prow.appendChild(pick); prow.appendChild(refIn); prow.appendChild(brIn); prow.appendChild(brPick);
  prow.appendChild(stTitle); prow.appendChild(start);
  historyPanel.appendChild(prow);
  try {
    const r = await apiFetch("/api/github/repos", { cache: "no-store" }).then((r) => r.json());
    for (const repo of (r.repos || []).slice(0, 30)) {
      const o = el("option", null, repo.fullName);
      o.value = repo.fullName;
      pick.appendChild(o);
    }
  } catch { /* repo list is best-effort; the input still works */ }
  let chats = [];
  try {
    const r = await apiFetch("/api/chats", { cache: "no-store" }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    chats = r.chats || [];
    updateRepoBadge(r.linked || null);
    ghSetLinked(r.linked || null);
  } catch (e) {
    historyPanel.appendChild(el("div", "msg err", "could not load history: " + (e.message ?? e)));
    return;
  }
  if (!chats.length) {
    historyPanel.appendChild(el("div", "msg thinking", "No snapshots yet — they appear here after each agent reply."));
    return;
  }
  for (const c of chats) {
    const item = el("div", "item");
    const titleEl = el("div", "t", c.title || "(untitled)");
    titleEl.title = "Tap to resume this snapshot";
    titleEl.setAttribute("role", "button");
    titleEl.setAttribute("tabindex", "0");
    item.appendChild(titleEl);
    const when = c.createdAt ? new Date(c.createdAt).toLocaleString() : "";
    item.appendChild(el("div", "m", when + " · " + c.messageCount + " messages" + (c.by ? " · by " + c.by : "")));
    if (c.preview) item.appendChild(el("div", "p", c.preview));
    item.appendChild(el("div", "repo", repoLabel(c.repo || null)));
    let resuming = false;
    const doResume = async () => {
      if (busy || resuming) return;
      resuming = true;
      try {
        const r = await apiFetch("/api/chats/" + encodeURIComponent(c.id) + "/resume", { method: "POST" })
          .then((r) => r.json());
        if (r.error) throw new Error(r.error);
        files = r.files || files;
        const sorted = Object.keys(files).sort();
        // files can be empty while the kept activeFile is still a valid
        // string: only switch when a restored file exists, so editor input
        // never writes under an "undefined" key.
        if (!(activeFile in files) && sorted[0]) activeFile = sorted[0];
        built = r.built;
        setMetrics(built);
        renderHistory(r.messages);
        // The header shows the CURRENT link only: falling back to the
        // snapshot repo here would display a repo that is no longer linked.
        updateRepoBadge(r.linked || null);
        ghSetLinked(r.linked || null);
        // History is its own tab now: return to Chat so the resumed
        // transcript is visible.
        view = "chat";
        syncTabs();
        renderPane();
        log.appendChild(el("div", "msg thinking",
          "Resumed saved session. Code restored." + (r.repoNote ? " " + r.repoNote : "")));
        scroll();
      } catch (e) {
        historyError("resume failed: " + (e.message ?? e));
      } finally {
        resuming = false;
      }
    };
    titleEl.onclick = doResume;
    titleEl.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); doResume(); } };
    const rrow = el("div", "hrow");
    const nameBtn = el("button", "icon", "✎");
    nameBtn.title = "Rename snapshot";
    nameBtn.setAttribute("aria-label", "Rename snapshot");
    nameBtn.onclick = () => {
      const input = document.createElement("input");
      input.value = c.title || "";
      const ok = el("button", "primary", "Save");
      const cancel = el("button", null, "Cancel");
      const edit = el("div", "hrow");
      edit.appendChild(input);
      edit.appendChild(ok);
      edit.appendChild(cancel);
      titleEl.replaceWith(edit);
      rrow.hidden = true;
      input.focus();
      input.select();
      cancel.onclick = () => {
        edit.replaceWith(titleEl);
        rrow.hidden = false;
      };
      ok.onclick = async () => {
        ok.disabled = true;
        try {
          const r = await apiFetch("/api/chats/" + encodeURIComponent(c.id) + "/rename", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: input.value }),
          }).then((r) => r.json());
          if (r.error) throw new Error(r.error);
          await loadChats();
        } catch (e) {
          historyError("rename failed: " + (e.message ?? e));
          ok.disabled = false;
        }
      };
    };
    rrow.appendChild(nameBtn);
    const delBtn = el("button", "icon", "🗑");
    delBtn.title = "Delete snapshot";
    delBtn.setAttribute("aria-label", "Delete snapshot");
    delBtn.onclick = () => {
      const confirm = el("button", "primary", "Confirm delete");
      const cancel = el("button", null, "Cancel");
      const edit = el("div", "hrow");
      edit.appendChild(confirm);
      edit.appendChild(cancel);
      titleEl.replaceWith(edit);
      rrow.hidden = true;
      cancel.onclick = () => {
        edit.replaceWith(titleEl);
        rrow.hidden = false;
      };
      confirm.onclick = async () => {
        confirm.disabled = true;
        try {
          const r = await apiFetch("/api/chats/" + encodeURIComponent(c.id) + "/delete", {
            method: "POST",
          }).then((r) => r.json());
          if (r.error) throw new Error(r.error);
          await loadChats();
        } catch (e) {
          historyError("delete failed: " + (e.message ?? e));
          confirm.disabled = false;
        }
      };
    };
    rrow.appendChild(delBtn);
    item.appendChild(rrow);
    historyPanel.appendChild(item);
  }
}

`;
