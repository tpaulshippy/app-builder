export const PANE_JS = `/* ---------- views: one tab visible at a time ---------- */
const chatSection = document.getElementById("chat");
function renderPane() {
  // Anonymous visitors get the login gate instead of any app view; the
  // GitHub tab stays reachable so login/logout still works from the tab.
  if (!authed && view !== "github") {
    chatSection.hidden = true;
    pane.hidden = true;
    gate.hidden = false;
    return;
  }
  gate.hidden = true;
  // Opening another repo can gain or lose the capsule entries, so the
  // Database tab (capsule repos only) re-syncs on every render — including
  // redirecting a stale database view back to Preview.
  syncCapsuleTabs();
  const isChat = view === "chat";
  chatSection.hidden = !isChat;
  pane.hidden = isChat;
  if (isChat) {
    scroll();
    return;
  }
  // The frame is actually removed here, so its expiry reports end here too.
  appFrameEl = null;
  pane.innerHTML = "";
  if (view === "history") {
    const wrap = el("div");
    wrap.id = "history";
    pane.appendChild(wrap);
    loadChats().catch((e) => wrap.appendChild(el("div", "msg err", "could not load history: " + (e.message ?? e))));
    return;
  }
  if (view === "code") {
    renderCode();
    return;
  }
  if (view === "github") {
    renderGitHub();
    return;
  }
  if (view === "preview") {
    const hasCapsule = hasCapsuleFiles();
    const htmlFiles = Object.keys(files).filter((p) => p.toLowerCase().endsWith(".html")).sort();
    if (hasCapsule) {
      const err = built && built.error;
      if (err) {
        const b = el("div", "banner");
        b.appendChild(el("b", null, err.name || "Build error"));
        b.appendChild(document.createTextNode("\\n" + err.message));
        if (err.stack) b.appendChild(document.createTextNode("\\n" + err.stack));
        pane.appendChild(b);
      } else {
        // The live app, running for real in a sandboxed iframe against the
        // isolate's database — not a snapshot. The iframe is opaque-origin
        // (no allow-same-origin), so capsule code can neither touch this page
        // nor read the browser's API key.
        const wrap = el("div");
        wrap.id = "appwrap";
        const sid = sessionId();
        if (!sid) {
          wrap.appendChild(el("div", "empty", "Session not ready — reload the page."));
        } else {
          const mount = el("div", "empty", "Loading live app…");
          wrap.appendChild(mount);
          previewToken().then((preview) => {
            if (!mount.isConnected) return;
            const frame = document.createElement("iframe");
            frame.id = "appframe";
            frame.title = "Capsule app";
            frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
            frame.setAttribute("referrerpolicy", "no-referrer");
            frame.src = "/api/app?sid=" + encodeURIComponent(sid) + "&preview=" + encodeURIComponent(preview) + "&v=" + appV;
            mount.replaceWith(frame);
            appFrameEl = frame;
            // A 401 at mount renders as plain text inside the sandbox, invisible
            // to the parent: probe the same endpoint family from here instead —
            // apiFetch flips to the gate on a login-required 401.
            apiFetch("/api/app-state?sid=" + encodeURIComponent(sid) + "&preview=" + encodeURIComponent(preview), { cache: "no-store" })
              .then((r) => r.json()).catch(() => {});
          }).catch((e) => {
            if (mount.isConnected) mount.textContent = "could not load preview: " + (e.message ?? e);
          });
        }
        pane.appendChild(wrap);
      }
    } else if (htmlFiles.length) {
      // No capsule: preview a static html file from the repo instead. Local
      // stylesheets and scripts are inlined (the sandboxed srcdoc frame
      // blocks even blob: subresources), so multi-file pages render styled.
      if (!activePreview || !(activePreview in files)) {
        activePreview = pickPreviewHtml(files) || htmlFiles[0];
      }
      const wrap = el("div");
      wrap.id = "appwrap";
      if (htmlFiles.length > 1) {
        // Several html files: the picker bar sits above the frame in a flex
        // column, so the absolute-fill frame does not cover it.
        wrap.style.display = "flex";
        wrap.style.flexDirection = "column";
        const bar = el("div");
        bar.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;padding:10px 14px 0;flex:0 0 auto;";
        for (const p of htmlFiles) {
          const b = el("button", null, p);
          b.style.cssText = "background:" + (p === activePreview ? "var(--accent);color:#111;border:0;font-weight:600;" : "var(--panel2);color:var(--fg);border:1px solid var(--edge);") + "border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;";
          b.onclick = () => { activePreview = p; renderPane(); };
          bar.appendChild(b);
        }
        wrap.appendChild(bar);
      }
      const frame = document.createElement("iframe");
      frame.id = "appframe";
      frame.title = "HTML preview: " + activePreview;
      frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.srcdoc = inlineLocalAssets(files, activePreview, files[activePreview] ?? "");
      if (htmlFiles.length > 1) {
        frame.style.flex = "1 1 auto";
        frame.style.height = "auto";
        frame.style.minHeight = "0";
      }
      wrap.appendChild(frame);
      // Deliberately not registered as appFrameEl: only the capsule frame
      // may report auth loss via postMessage. A static repo file could
      // otherwise post "app-builder:auth-required" and force the login gate.
      pane.appendChild(wrap);
    } else {
      const err = built && built.error;
      if (err) {
        const b = el("div", "banner");
        b.appendChild(el("b", null, err.name || "Build error"));
        b.appendChild(document.createTextNode("\\n" + err.message));
        if (err.stack) b.appendChild(document.createTextNode("\\n" + err.stack));
        pane.appendChild(b);
      } else {
        pane.appendChild(el("div", "empty", "No capsule or html file to preview — open a repo with an html file, or ask the agent to build a capsule."));
      }
    }
  } else if (view === "logs") {
    const d = el("div");
    d.id = "logs";
    const lines = (built && built.logs) || [];
    if (!lines.length) d.textContent = "No console output.";
    for (const line of lines) {
      const kind = line.split(" ")[0];
      const span = el("span", kind === "error" ? "error" : kind === "warn" ? "warn" : null, line + "\\n");
      d.appendChild(span);
    }
    pane.appendChild(d);
  } else if (view === "database") {
    // Live database state behind the app view (the app's own writes land
    // here), fetched from the isolate — not the last build snapshot. The tab
    // only shows for capsule repos (see syncCapsuleTabs).
    const loading = el("div", "empty", "Loading live state…");
    pane.appendChild(loading);
    const sid = sessionId();
    if (!sid) {
      loading.textContent = "Session not ready — reload the page.";
    } else {
      previewToken().then((preview) => {
        if (!loading.isConnected) return;
        return apiFetch("/api/app-state?sid=" + encodeURIComponent(sid) + "&preview=" + encodeURIComponent(preview), { cache: "no-store" })
          .then((r) => r.json())
        .then((st) => {
          if (!loading.isConnected) return;
          loading.innerHTML = "";
          if (!st.ok) {
            loading.appendChild(el("div", "err", "state error: " + ((st.error && st.error.message) || "unknown")));
            return;
          }
          const wrap = el("div");
          wrap.id = "preview";
          wrap.appendChild(el("p", "muted",
            "tables: " + (st.tables.join(", ") || "(none)") + " · in-memory, resets on rebuild — lakebed dev semantics"));
          for (const entry of Object.entries(st.queries)) {
            wrap.appendChild(el("h1", null, entry[0]));
            const pre = el("pre", null, JSON.stringify(entry[1], null, 2));
            pre.style.cssText = "font:11.5px/1.5 var(--mono);white-space:pre-wrap;color:var(--dim)";
            wrap.appendChild(pre);
          }
          loading.replaceWith(wrap);
        })
        .catch((e) => {
          if (loading.isConnected) loading.textContent = "could not load state: " + (e.message ?? e);
        });
      });
    }
  }
  pane.scrollTop = 0;
}

function renderCode() {
  const diag = diagBanner();
  if (diag) pane.appendChild(diag);
  const wrap = el("div");
  wrap.id = "code";
  const tree = el("div");
  tree.id = "tree";
  for (const path of Object.keys(files).sort()) {
    const d = el("div", null, path);
    if (path === activeFile) d.setAttribute("aria-current", "true");
    d.onclick = () => { activeFile = path; renderPane(); };
    tree.appendChild(d);
  }
  const ed = el("textarea");
  ed.id = "editor";
  ed.spellcheck = false;
  ed.value = files[activeFile] ?? "";
  ed.oninput = () => { files[activeFile] = ed.value; };
  wrap.appendChild(tree);
  wrap.appendChild(ed);

  const bar = el("div");
  bar.id = "savebar";
  const snapName = document.createElement("input");
  snapName.id = "snapname";
  snapName.placeholder = "Snapshot name (optional)";
  snapName.title = "Checkpoint chat + code under this name";
  const snapBtn = el("button", null, "Snapshot");
  snapBtn.id = "snapbtn";
  snapBtn.title = "Checkpoint chat + code (kept in History)";
  snapBtn.disabled = busy;
  snapBtn.onclick = async () => {
    // A mid-turn snapshot would queue behind the turn lock and then persist
    // this pre-turn map over the turn's files (see snapshotChat): block it
    // like Commit/Create instead, so retrying captures both.
    if (busy) {
      addError("snapshot blocked: an agent turn is running — wait for it to finish, then retry");
      return;
    }
    snapBtn.disabled = true;
    const done = (label) => {
      snapBtn.textContent = label;
      setTimeout(() => {
        if (!snapBtn.isConnected) return;
        snapBtn.disabled = false;
        snapBtn.textContent = "Snapshot";
      }, 1500);
    };
    try {
      // Send the in-memory editor map: Code-tab edits live in browser memory
      // until Save-and-build, and the server would otherwise snapshot the
      // last-saved copy. The server persists this map inside the turn lock
      // before checkpointing, so a mid-turn save cannot clobber agent edits.
      const r = await apiFetch("/api/chats/snapshot", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: snapName.value, files }),
      }).then((r) => r.json());
      if (r.error) throw new Error(r.error);
      snapName.value = "";
      done("Saved ✓");
    } catch (e) {
      addError("snapshot failed: " + (e.message ?? e));
      done("Failed — retry");
    }
  };
  const btn = el("button", null, "Save and build");
  btn.id = "save";
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = "Building…";
    const r = await apiFetch("/api/file", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: activeFile, content: files[activeFile], baseVersion: filesVersion }),
    }).then((r) => r.json());
    if (r.error) {
      // A teammate persisting first still 409s with the server files: adopt
      // them (reload prompt) instead of keeping the stale editor copy.
      if (r.files) {
        files = r.files;
        if (typeof r.version === "number") filesVersion = r.version;
        renderPane();
      }
      btn.disabled = false; btn.textContent = "Save and build";
      addError("save failed: " + r.error);
      return;
    }
    if (r.files) files = r.files;
    if (typeof r.version === "number") filesVersion = r.version;
    built = r.built;
    setMetrics(built);
    btn.disabled = false; btn.textContent = "Save and build";
    renderPane();
  };
  bar.appendChild(snapName);
  bar.appendChild(snapBtn);
  bar.appendChild(btn);
  wrap.appendChild(bar);
  pane.appendChild(wrap);
}

`;
