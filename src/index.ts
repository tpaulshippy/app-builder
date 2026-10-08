import { AppSession } from "./session";
import { agentTurn, MODEL, type AgentEvent } from "./agent";
import type { RunResult } from "./sandbox";

export interface Env {
  APP: DurableObjectNamespace<AppSession>;
  OPENCODE_ZEN_KEY: string;
}

export { AppSession };

const SESSION_COOKIE = "ab_session";

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * One session id, carried by cookie, selects the Durable Object that owns the
 * files, the chat history, and the QuickJS runtime. A cookie rather than
 * localStorage because cookies are keyed on host alone: the port can change
 * behind a proxy and the session must survive that.
 */
function resolveSession(req: Request): { id: string; isNew: boolean } {
  const fromCookie = readCookie(req, SESSION_COOKIE);
  if (fromCookie && /^[A-Za-z0-9_-]{8,64}$/.test(fromCookie)) return { id: fromCookie, isNew: false };
  return { id: crypto.randomUUID(), isNew: true };
}

const withSession = (headers: Headers, session: { id: string; isNew: boolean }) => {
  // Secure is omitted so the cookie also works over plain http in local dev.
  if (session.isNew) {
    headers.append("set-cookie", `${SESSION_COOKIE}=${session.id}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }
  return headers;
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const session = resolveSession(req);
    const stub = env.APP.get(env.APP.idFromName(session.id));

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
      return new Response(page(), { headers: withSession(headers, session) });
    }

    if (url.pathname === "/api/state") {
      const files = await stub.getFiles();
      const messages = await stub.getMessages();
      const built = await stub.build();
      return sessionJson({ files, messages, built }, session, 200, { "cache-control": "no-store" });
    }

    if (url.pathname === "/api/build" && req.method === "POST") {
      return sessionJson({ built: await stub.build() }, session);
    }

    if (url.pathname === "/api/file" && req.method === "POST") {
      const { path, content } = (await req.json()) as { path?: string; content?: string };
      const files = { ...(await stub.getFiles()) };
      const key = (path ?? "").trim() || "index.ts";
      if (!/^[\w./-]+$/.test(key) || key.includes("..")) {
        return sessionJson({ error: "unsafe path" }, session, 400);
      }
      files[key] = content ?? "";
      await stub.setFiles(files);
      return sessionJson({ files, built: await stub.build() }, session);
    }

    if (url.pathname === "/api/reset" && req.method === "POST") {
      return sessionJson(await stub.reset(), session);
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const { message } = (await req.json()) as { message?: string };
      if (!message || !message.trim()) return sessionJson({ error: "empty message" }, session, 400);
      if (!env.OPENCODE_ZEN_KEY) {
        return sessionJson({ error: "OPENCODE_ZEN_KEY is not set on this Worker" }, session, 500);
      }

      // Adapter over the Durable Object so the agent can treat it as one object.
      const api = {
        getFiles: () => stub.getFiles(),
        setFiles: (f: any) => stub.setFiles(f),
        getMessages: () => stub.getMessages(),
        setMessages: (m: any) => stub.setMessages(m),
        build: (f?: any) => stub.build(f),
      };

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          const send = (event: AgentEvent) =>
            controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
          try {
            for await (const event of agentTurn(api, env.OPENCODE_ZEN_KEY, message)) send(event);
          } catch (e) {
            send({ type: "error", message: e?.message ?? String(e) });
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: withSession(
          new Headers({
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          }),
          session,
        ),
      });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function sessionJson(
  body: unknown,
  session: { id: string; isNew: boolean },
  status = 200,
  extra: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: withSession(
      new Headers({ "content-type": "application/json; charset=utf-8", ...extra }),
      session,
    ),
  });
}

const page = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>app-builder</title>
<style>
  :root {
    --bg:#08090a; --panel:#0e1011; --panel2:#141617; --edge:#232627;
    --fg:#e8eaeb; --dim:#7d8285; --faint:#4a4f52; --accent:#d8f06a;
    --ok:#7ee787; --err:#ff7b72; --warn:#e3b341;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; margin:0; }
  body { background:var(--bg); color:var(--fg); font:13px/1.55 var(--sans); display:flex; flex-direction:column; overflow:hidden; }

  /* top bar */
  header { display:flex; align-items:center; gap:2px; padding:0 10px; height:38px;
           border-bottom:1px solid var(--edge); background:var(--panel); flex:0 0 auto; }
  .tab { padding:5px 11px; border-radius:6px; color:var(--dim); cursor:pointer; font-size:12.5px; }
  .tab:hover { background:var(--panel2); color:var(--fg); }
  .tab[aria-selected="true"] { background:var(--panel2); color:var(--fg); }
  .tab.add { color:var(--faint); }
  .metrics { margin-left:auto; display:flex; gap:16px; align-items:center;
             font:10.5px/1 var(--mono); text-transform:uppercase; letter-spacing:.6px; color:var(--faint); }
  .metrics b { color:var(--dim); font-weight:600; }
  .metrics .built { color:var(--ok); text-transform:none; letter-spacing:0; font-size:11.5px; }
  .metrics .failed { color:var(--err); text-transform:none; letter-spacing:0; font-size:11.5px; }

  main { flex:1; display:grid; grid-template-columns:minmax(300px,26%) 1fr; min-height:0; }

  /* chat column */
  #chat { border-right:1px solid var(--edge); display:flex; flex-direction:column; min-height:0; background:var(--bg); }
  #log { flex:1; overflow-y:auto; padding:14px 14px 8px; }
  .who { font:10px/1 var(--mono); text-transform:uppercase; letter-spacing:1px; color:var(--faint); margin:2px 0 8px; }
  .msg { margin:0 0 14px; white-space:pre-wrap; }
  .msg.user { color:var(--fg); }
  .msg.agent { color:#c9ced1; }
  .tool { display:flex; gap:7px; align-items:baseline; color:var(--dim); font-size:12.5px; margin:3px 0; }
  .tool .mark { color:var(--ok); font-family:var(--mono); }
  .tool.bad .mark { color:var(--err); }
  .model { font:10.5px/1 var(--mono); text-transform:uppercase; letter-spacing:.7px; color:var(--faint); margin:6px 0 2px; }
  .err { color:var(--err); font-size:12.5px; }
  .thinking { color:var(--faint); font-style:italic; }

  #composer { flex:0 0 auto; padding:8px 12px 12px; }
  #box { border:1px solid var(--edge); border-radius:10px; background:var(--panel); padding:9px 10px 7px; }
  #box:focus-within { border-color:#3a4043; }
  #input { width:100%; border:0; outline:0; resize:none; background:transparent; color:var(--fg);
           font:13px/1.5 var(--sans); min-height:38px; max-height:140px; }
  #input::placeholder { color:var(--faint); }
  .crow { display:flex; align-items:center; gap:8px; margin-top:4px; }
  .badge { display:flex; align-items:center; gap:5px; font:10.5px/1 var(--mono); color:var(--dim); }
  .badge .star { color:var(--accent); font-size:12px; }
  #send { margin-left:auto; width:26px; height:26px; border-radius:6px; border:0; cursor:pointer;
          background:var(--accent); color:#111; font-size:14px; line-height:1; display:grid; place-items:center; }
  #send:disabled { opacity:.4; cursor:default; }

  /* right pane */
  #right { display:flex; flex-direction:column; min-width:0; min-height:0; }
  .subtabs { display:flex; gap:2px; padding:6px 10px; border-bottom:1px solid var(--edge);
             background:var(--panel); flex:0 0 auto; }
  #pane { flex:1; overflow:hidden; position:relative; }
  #preview { padding:26px 30px; }
  #preview h1 { font-size:20px; margin:0 0 4px; letter-spacing:-.2px; }
  #preview .muted { color:var(--dim); margin:0 0 18px; font-size:13px; }
  #preview ul { list-style:none; padding:0; margin:0; }
  #preview li { border:1px solid var(--edge); background:var(--panel); border-radius:7px;
                padding:9px 12px; margin-bottom:6px; }
  #logs { padding:10px 14px; font:12px/1.6 var(--mono); white-space:pre-wrap; color:var(--dim); }
  #logs .warn { color:var(--warn); } #logs .error { color:var(--err); }
  .empty { color:var(--faint); padding:40px 30px; }
  .banner { background:rgba(255,123,114,.07); border:1px solid rgba(255,123,114,.35);
            border-radius:7px; padding:11px 13px; color:#ffa39b; font:12px/1.6 var(--mono);
            white-space:pre-wrap; margin:0 30px 16px; }
  .banner b { color:var(--err); }

  /* code view */
  #code { display:grid; grid-template-columns:180px 1fr; height:100%; min-height:0; }
  #tree { border-right:1px solid var(--edge); overflow:auto; padding:8px 0; background:var(--panel); }
  #tree div { padding:5px 12px; cursor:pointer; color:var(--dim); font:12px var(--mono); }
  #tree div[aria-current="true"] { background:var(--panel2); color:var(--fg); }
  #editor { border:0; outline:0; resize:none; width:100%; height:100%; padding:14px 16px;
            background:var(--bg); color:var(--fg); font:12.5px/1.65 var(--mono); tab-size:2; }
  #savebar { position:absolute; right:18px; bottom:16px; }
  #save { background:var(--accent); color:#111; border:0; border-radius:6px; padding:6px 13px;
          font-weight:600; font-size:12px; cursor:pointer; }
</style>
</head>
<body>
<header>
  <span class="tab" data-view="code" role="tab">Code</span>
  <span class="tab" data-view="preview" role="tab" aria-selected="true">Preview</span>
  <span class="tab" data-view="resources" role="tab">Resources</span>
  <span class="tab add">+</span>
  <div class="metrics">
    <span>process ram <b>—</b></span>
    <span>process cpu <b>—</b></span>
    <span>typecheck <b>—</b></span>
    <span>bundle <b id="m-bundle">—</b></span>
    <span id="m-built" class="built">idle</span>
  </div>
</header>
<main>
  <section id="chat">
    <div id="log"></div>
    <div id="composer">
      <div id="box">
        <textarea id="input" placeholder="What do you want to build?" rows="2"></textarea>
        <div class="crow">
          <span class="badge"><span class="star">✳</span> ${MODEL}</span>
          <button id="send" title="Send">↑</button>
        </div>
      </div>
    </div>
  </section>
  <section id="right">
    <div class="subtabs">
      <span class="tab" data-pane="preview" aria-selected="true">Preview</span>
      <span class="tab" data-pane="database">Database</span>
      <span class="tab" data-pane="logs">Logs</span>
    </div>
    <div id="pane"></div>
  </section>
</main>
<script>
const MODEL = ${JSON.stringify(MODEL)};
const log = document.getElementById("log");

// Surface script errors in the transcript. Without this a throw before the
// first render leaves the page silently idle.
window.addEventListener("error", (e) => {
  const n = document.createElement("div");
  n.className = "err";
  n.textContent = "js error: " + (e.message || String(e.error));
  log.appendChild(n);
});
const pane = document.getElementById("pane");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const mBundle = document.getElementById("m-bundle");
const mBuilt = document.getElementById("m-built");

let view = "preview";
let inner = "preview";
let files = { "index.ts": "" };
let activeFile = "index.ts";
let built = null;
let busy = false;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ---------- chat transcript ---------- */
function addUser(text) {
  log.appendChild(el("div", "who", "you"));
  log.appendChild(el("div", "msg user", text));
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
function addAgent(text) {
  log.appendChild(el("div", "msg agent", text));
  const m = el("div", "model", "✳ " + MODEL);
  log.appendChild(m);
  scroll();
}
function addError(text) {
  log.appendChild(el("div", "msg err", text));
  scroll();
}
function scroll() { log.scrollTop = log.scrollHeight; }

/* ---------- right pane ---------- */
function renderPane() {
  pane.innerHTML = "";
  if (inner === "preview") {
    const err = built && (built.error || built.compileError);
    if (err) {
      const b = el("div", "banner");
      b.appendChild(el("b", null, err.name || "Compile error"));
      b.appendChild(document.createTextNode("\\n" + err.message));
      if (err.stack) b.appendChild(document.createTextNode("\\n" + err.stack));
      pane.appendChild(b);
    }
    const out = built ? built.html : "";
    if (out) {
      // Render into a shadow root, not the page. Generated code routinely ships its
      // own <style>, which would restyle the chat and header around it. A
      // sandboxed srcdoc iframe would isolate just as well and give the output
      // a real document, but it does not paint reliably here, so: shadow DOM,
      // with scripts stripped since rendered output is not a place to run code.
      //
      // A shadow root has no :root, and generated CSS very often defines its
      // custom properties there. Rewriting :root to :host inside <style> keeps
      // every var() in the app's stylesheet resolvable.
      const safe = out
        .replace(/<script\\b[\\s\\S]*?<\\/script>/gi, "")
        // Document-level tags mean nothing inside a shadow root and can cost
        // elements during fragment parsing, so drop them.
        .replace(/<!doctype[^>]*>/gi, "")
        .replace(/<\\/?(?:html|head|body)\\b[^>]*>/gi, "")
        .replace(/<meta\\b[^>]*charset[^>]*>/gi, "")
        .replace(/(<style\\b[^>]*>)([\\s\\S]*?)(<\\/style>)/gi,
          (_m, open, css, close) => open + css.replace(/:root\\b/g, ":host") + close);
      const host = document.createElement("div");
      // The host scrolls its own content rather than letting the pane do it, so
      // re-rendering always lands at the top of the app instead of wherever the
      // previous build happened to be scrolled to.
      host.style.cssText = "display:block;width:100%;height:100%;min-height:520px;overflow:auto";
      const shadow = host.attachShadow({ mode: "open" });
      // Painted first so the app's own rules override it.
      shadow.innerHTML =
        "<style>:host{display:block;min-height:520px}" +
        "body{margin:0;padding:20px 24px;font:13px/1.55 system-ui,-apple-system,sans-serif}" +
        "</style>" + safe;
      pane.appendChild(host);
    } else if (!err) {
      pane.appendChild(el("div", "empty", "No output yet. Ask for something, or press Build."));
    }
  } else if (inner === "logs") {
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
  } else if (inner === "database") {
    pane.appendChild(el("div", "empty",
      "No database yet. The agent writes \\u003cindex.ts\\u003e; storage would be the next layer."));
  } else if (view === "code") {
    renderCode();
    return;
  } else if (view === "resources") {
    const d = el("div");
    d.className = "empty";
    d.style.whiteSpace = "pre-wrap";
    d.textContent = [
      "runtime     QuickJS (WASM) in a Durable Object",
      "compiler    sucrase (TypeScript -> JavaScript, no type checking)",
      "model       " + MODEL + " via opencode zen",
      "state       persists per session, in the isolate",
      "",
      "process ram / cpu are not observable from inside a Worker,",
      "so they stay blank rather than showing invented numbers.",
    ].join("\\n");
    pane.appendChild(d);
  }
  pane.scrollTop = 0;
}

function renderCode() {
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
  const btn = el("button", null, "Save and build");
  btn.id = "save";
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = "Building…";
    const r = await fetch("/api/file", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: activeFile, content: files[activeFile] }),
    }).then((r) => r.json());
    if (r.files) files = r.files;
    built = r.built;
    setMetrics(built);
    btn.disabled = false; btn.textContent = "Save and build";
    renderPane();
  };
  bar.appendChild(btn);
  wrap.appendChild(bar);
  pane.appendChild(wrap);
}

function setMetrics(b) {
  mBundle.textContent = b && b.durationMs != null ? b.durationMs + " ms" : "—";
  if (!b) { mBuilt.textContent = "idle"; mBuilt.className = "built"; return; }
  const bad = !b.ok || b.compileError;
  mBuilt.textContent = bad ? "failed" : "built";
  mBuilt.className = bad ? "failed" : "built";
}

/* ---------- agent stream ---------- */
async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = "";
  busy = true; sendBtn.disabled = true;
  addUser(text);
  const thinking = addThinking();

  let agentText = "";
  const flush = () => {
    if (thinking.isConnected) thinking.remove();
    if (agentText) addAgent(agentText);
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok || !res.body) throw new Error("chat request failed: " + res.status);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\\n\\n");
      buf = frames.pop() || "";
      for (const frame of frames) {
        const line = frame.split("\\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "text") {
          agentText += ev.text;
          thinking.textContent = agentText.slice(0, 400);
        } else if (ev.type === "tool") {
          if (thinking.isConnected) thinking.remove();
          addTool(ev.name, ev.detail);
          agentText = "";
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
          files = ev.files;
          setMetrics(built);
          renderPane();
        } else if (ev.type === "error") {
          flush();
          addError(ev.message);
        }
      }
    }
    flush();
  } catch (e) {
    if (thinking.isConnected) thinking.remove();
    addError(e.message ?? String(e));
  } finally {
    busy = false; sendBtn.disabled = false;
    input.focus();
  }
}

sendBtn.onclick = send;
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(140, input.scrollHeight) + "px";
});

document.querySelectorAll("[data-view]").forEach((n) => {
  n.onclick = () => {
    document.querySelectorAll("[data-view]").forEach((o) => o.removeAttribute("aria-selected"));
    n.setAttribute("aria-selected", "true");
    view = n.dataset.view;
    if (view !== "code") inner = view;
    renderPane();
  };
});
document.querySelectorAll("[data-pane]").forEach((n) => {
  n.onclick = () => {
    document.querySelectorAll("[data-pane]").forEach((o) => o.removeAttribute("aria-selected"));
    n.setAttribute("aria-selected", "true");
    inner = n.dataset.pane;
    view = inner;
    renderPane();
  };
});

(async () => {
  try {
    // no-store: /api/state runs a build, so any cached copy is already wrong.
    const s = await fetch("/api/state", { cache: "no-store" }).then((r) => r.json());
    if (s.error) throw new Error(s.error);
    files = s.files || files;
    built = s.built;
    setMetrics(built);
    renderPane();
  } catch (e) {
    mBuilt.textContent = "state error";
    mBuilt.className = "failed";
    log.appendChild(el("div", "err", "could not load state: " + (e.message ?? e)));
  }
})();
</script>
</body>
</html>`;