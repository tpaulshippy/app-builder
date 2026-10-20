export const TRANSCRIPT_JS = `/* ---------- chat transcript ---------- */
function userImages(m) {
  return Array.isArray(m && m.images) ? m.images.filter((img) => img && img.id && img.mimeType) : [];
}
function appendImages(container, images) {
  if (!images.length) return;
  const wrap = el("div", "imgs");
  for (const img of images) {
    const pic = document.createElement("img");
    pic.src = "/api/images/" + encodeURIComponent(img.id);
    pic.alt = "attached image";
    pic.loading = "lazy";
    wrap.appendChild(pic);
  }
  container.appendChild(wrap);
}
function addUser(text, images, author) {
  log.appendChild(el("div", "who", author ? author : "you"));
  const bubble = el("div", "msg user", text);
  appendImages(bubble, images || []);
  log.appendChild(bubble);
  scroll();
}
function addThinking() {
  const n = el("div", "msg thinking", "thinking…");
  log.appendChild(n); scroll();
  return n;
}
function addTool(name, detail, ok) {
  const row = el("div", ok === false ? "tool bad" : "tool");
  row.appendChild(el("span", "mark", ok === false ? "✗" : "✓"));
  row.appendChild(el("span", null, detail || name));
  if (ok !== false && detail) row.title = detail;
  log.appendChild(row);
  scroll();
}
function addAgent(text, badge) {
  const bubble = el("div", "msg agent", null);
  bubble.innerHTML = markdownToHtml(text);
  log.appendChild(bubble);
  // Restored history passes badge=false: the badge names the picker's
  // current gateway/model, which may differ from what wrote the history.
  if (badge !== false) {
    const m = el("div", "model", "✳ " + getGateway() + "/" + modelSel.value);
    log.appendChild(m);
  }
  scroll();
}
function addError(text) {
  log.appendChild(el("div", "msg err", text));
  scroll();
}
function scroll() { log.scrollTop = log.scrollHeight; }

// Restored on every load so a refresh no longer hides the context the agent
// still carries. Tool turns are skipped: they are noise in a restored view.
function renderHistory(messages) {
  log.innerHTML = "";
  // The agent persists narration twice per tool round (once as prose, once
  // paired with its tool calls), so consecutive identical assistant turns are
  // one message stored twice. Render it once; reset on user turns so a
  // genuinely repeated answer across turns still shows.
  let lastAgent = null;
  for (const m of messages || []) {
    if (m.role === "user") {
      // Shared playgrounds attribute each turn to its author.
      addUser(m.content, userImages(m), m.author);
      lastAgent = null;
    } else if (m.role === "assistant" && m.content && m.content.trim()) {
      if (m.content === lastAgent) continue;
      lastAgent = m.content;
      addAgent(m.content, false);
    }
  }
  scroll();
}
const newchatBtn = document.getElementById("newchat");
if (newchatBtn) {
  newchatBtn.onclick = async () => {
    if (busy) return;
    newchatBtn.disabled = true;
    try {
      const r = await apiFetch("/api/clear-chat", { method: "POST" });
      if (!r.ok) throw new Error("clear failed: " + r.status);
      log.innerHTML = "";
      log.appendChild(el("div", "msg thinking", "Context cleared — starting fresh. Code unchanged."));
    } catch (e) {
      addError(e.message ?? String(e));
    } finally {
      newchatBtn.disabled = false;
    }
  };
}

`;
