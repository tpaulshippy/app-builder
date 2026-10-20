export const AGENT_JS = `/* ---------- agent stream ---------- */
async function send() {
  const text = input.value.trim();
  const ready = pendingImages.filter((p) => p.id && !p.uploading);
  if ((!text && !ready.length) || busy || uploading > 0 || booting) return;
  const images = ready.map((p) => ({ id: p.id, mimeType: p.mimeType }));
  // Entries sent this turn: kept aside so a request that never reaches the
  // agent can be retried without re-uploading (their R2 objects persist).
  // Once the SSE stream opens, the DO owns the message (refs are persisted
  // before Pi even submits), so restoring would duplicate it — only
  // pre-acceptance failures restore.
  const sentEntries = ready;
  let accepted = false;
  input.value = "";
  input.style.height = "auto";
  pendingImages = [];
  renderPending();
  busy = true; sendBtn.disabled = true;
  // Shared playgrounds attribute the turn; the server stores it on the message.
  const me = (ghStatus && ghStatus.user && ghStatus.user.login) || null;
  addUser(text, images, me);
  const thinking = addThinking();
  // One agent turn runs at a time per playground: if nothing streams back
  // within a few seconds we are queued behind the other member's turn, not
  // stuck. Best-effort who/position from the sharing status.
  let firstEvent = false;
  const queueTimer = setTimeout(async () => {
    if (firstEvent || !thinking.isConnected) return;
    let who = "the other member's";
    try {
      const st = await apiFetch("/api/share/status", { cache: "no-store" }).then((r) => r.json());
      if (st && st.turn && st.turn.active) {
        who = st.turn.actor ? (st.turn.actor + "'s") : who;
        if (typeof st.turn.queued === "number" && st.turn.queued > 0) {
          thinking.textContent = "queued behind " + who + " turn (" + st.turn.queued + " waiting)…";
          return;
        }
      }
    } catch { /* best-effort label only */ }
    thinking.textContent = "queued behind " + who + " turn…";
  }, 3000);

  let settled = false;
  // Open narration segments by Pi content index. Deltas append to their
  // segment; a whole block replaces the segment with the same index when
  // it extends it (grown block), commits what is open and starts a fresh
  // bubble when the index is new (consecutive distinct paragraphs) or
  // when the same index carries non-extending text (retry rewrite,
  // redaction). Distinct text never overwrites visible text: the live
  // transcript keeps everything the restored snapshot will show.
  const segTexts = new Map();
  const segNodes = new Map();
  const segOrder = [];
  const previewText = () => segOrder.map((i) => segTexts.get(i) || "").join("");
  const showSeg = (i) => {
    if (thinking.isConnected) thinking.textContent = previewText().slice(0, 400);
    else {
      let node = segNodes.get(i);
      if (!node) { node = el("div", "msg agent", ""); log.appendChild(node); segNodes.set(i, node); }
      node.innerHTML = markdownToHtml(segTexts.get(i));
      scroll();
    }
  };
  const commitSegs = () => {
    if (thinking.isConnected) thinking.remove();
    const order = [...segOrder].sort((a, b) => a - b);
    let any = false;
    for (const i of order) {
      const t = segTexts.get(i);
      if (!t) continue;
      any = true;
      if (!segNodes.get(i)) {
        const bubble = el("div", "msg agent", "");
        bubble.innerHTML = markdownToHtml(t);
        log.appendChild(bubble);
      } else {
        segNodes.get(i).innerHTML = markdownToHtml(t);
      }
    }
    if (any) log.appendChild(el("div", "model", "✳ " + getGateway() + "/" + modelSel.value));
    segOrder.length = 0; segTexts.clear(); segNodes.clear();
    scroll();
  };
  const flush = () => commitSegs();

  const apiKey = readApiKey();
  if (apiKey) localStorage.setItem("ab_key", apiKey);
  try {
    const res = await apiFetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { "x-provider-key": apiKey } : {}) },
      body: JSON.stringify({
        message: text || "(see attached images)",
        gateway: getGateway(),
        model: modelSel.value,
        ...(images.length ? { images } : {}),
      }),
    });
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}));
      // The gate flip already happened inside apiFetch; the key-missing 401
      // keeps the chat visible with the key prompt.
      throw new Error(body.error || "unauthorized: set the API key below");
    }
    if (!res.ok || !res.body) throw new Error("chat request failed: " + res.status);
    // The stream is open, so the DO owns the turn (its refs were persisted
    // before Pi submission): from here on, failures must not restore the
    // sent entries, or a retry would duplicate the recorded message — and
    // removing a restored thumb could delete bytes history still needs.
    accepted = true;

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const drain = (final) => {
      const frames = buf.split("\\n\\n");
      buf = final ? "" : (frames.pop() || "");
      for (const frame of frames) {
        const line = frame.split("\\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (!firstEvent) {
          firstEvent = true;
          clearTimeout(queueTimer);
        }
        if (ev.type === "text") {
          const i = ev.index || 0;
          if (!segTexts.has(i)) segOrder.push(i);
          segTexts.set(i, (segTexts.get(i) || "") + ev.text);
          showSeg(i);
        } else if (ev.type === "text_block") {
          if (ev.text) {
            const i = ev.index || 0;
            const cur = segTexts.get(i);
            if (cur === undefined) {
              commitSegs();
              segOrder.push(i);
              segTexts.set(i, ev.text);
            } else if (ev.text !== cur && ev.text.indexOf(cur) !== 0) {
              // Same index but not a grown block (retry rewrite, redaction):
              // keep the open text as its own bubble instead of overwriting
              // it, so a revision never deletes visible narration.
              commitSegs();
              segOrder.push(i);
              segTexts.set(i, ev.text);
            } else {
              segTexts.set(i, ev.text);
            }
            showSeg(i);
          }
        } else if (ev.type === "tool") {
          // Flush any pending narration first: the model often sends text
          // ("building your redesign now") ahead of its tool calls in the
          // same round, and dropping it makes the transcript look stuck.
          commitSegs();
          addTool(ev.name, ev.detail);
        } else if (ev.type === "tool_result") {
          // The tool line already showed the action. Only surface a result
          // when it failed, otherwise the transcript is just file dumps.
          if (!ev.ok) addTool(ev.name, ev.detail, false);
        } else if (ev.type === "build") {
          built = ev.result;
          if (ev.result.files) files = ev.result.files;
          setMetrics(built);
          renderPane();
        } else if (ev.type === "done") {
          settled = true;
          files = ev.files;
          setMetrics(built);
          renderPane();
        } else if (ev.type === "error") {
          settled = true;
          flush();
          addError(ev.message);
        }
      }
    };
    // A failure inside the frame handlers must not silently drop narration
    // that already streamed: flush the open segments before the error
    // reaches the turn-level handler. The one exception is a partial tail
    // frame when the stream closes (complete-but-unterminated final frames
    // are recovered above; a truly partial one cannot parse and is skipped,
    // with the persisted transcript as its backstop).
    const drainGuarded = (final) => {
      try {
        drain(final);
      } catch (e) {
        if (final && e instanceof SyntaxError) return;
        try { commitSegs(); } catch { /* never mask the original failure */ }
        throw e;
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      drainGuarded(false);
    }
    drainGuarded(true);
    flush();
    // A killed proxy/Worker request closes the stream with no done/error,
    // which previously looked stuck after the last edit. Progress is saved
    // every round, so a retry continues cleanly.
    if (!settled) addError("interrupted before finishing — progress is saved, retry your message");
  } catch (e) {
    if (thinking.isConnected) thinking.remove();
    addError(e.message ?? String(e));
  } finally {
    clearTimeout(queueTimer);
    if (!accepted && sentEntries.length) {
      // The request never reached the agent, so nothing was recorded:
      // give the attachments back for a retry (plus anything attached
      // meanwhile), capped so the next send is not rejected outright.
      const restored = [...sentEntries, ...pendingImages];
      if (restored.length > 4) {
        addError("kept the first 4 attachments; remove some before retrying");
      }
      pendingImages = restored.slice(0, 4);
      renderPending();
    }
    busy = false; sendBtn.disabled = false;
    input.focus();
  }
}

sendBtn.onclick = send;
input.addEventListener("keydown", (e) => {
  // Enter inserts a newline for multiline prompts; ⌘/Ctrl+Enter sends.
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(140, input.scrollHeight) + "px";
});

`;
