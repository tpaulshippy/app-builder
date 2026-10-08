import { AppSession } from "./session";
import type { RunResult } from "./sandbox";

export { AppSession };

export interface Env {
  APP: DurableObjectNamespace<AppSession>;
}

const DEFAULT_CODE = `// TypeScript is compiled in the Worker, then executed inside a
// QuickJS VM compiled to WebAssembly. V8's eval() is disabled on
// Cloudflare Workers; this VM has its own, and V8 never sees it.
//
// state survives across Update clicks. Same isolate, same context.

interface Visitor {
  name: string;
  visits: number;
}

state.runs = (state.runs ?? 0) + 1;

const visitors: Visitor[] = [
  { name: "ada", visits: 3 },
  { name: "grace", visits: 7 },
  { name: "katherine", visits: 5 },
];

const ranked: Visitor[] = [...visitors].sort((a, b) => b.visits - a.visits);

console.log("rendering", ranked.length, "visitors on run", state.runs);

html\`
  <h1>Run ${"${state.runs}"}</h1>
  <p class="muted">Compiled and executed inside a Cloudflare Worker.</p>
  <ul>
    ${"${ranked.map((v) => \"<li><b>\" + v.name + \"</b><span>\" + v.visits + \" visits</span></li>\").join(\"\")}"}
  </ul>
\`;
`;

const page = (defaultCode: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>app-builder</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --edge: #30363d;
    --fg: #e6edf3; --dim: #8b949e; --accent: #58a6ff;
    --ok: #3fb950; --err: #f85149; --warn: #d29922;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--fg); display: flex;
    flex-direction: column; font: 14px/1.5 system-ui, sans-serif;
  }
  header {
    padding: 10px 16px; border-bottom: 1px solid var(--edge);
    display: flex; align-items: center; gap: 14px; background: var(--panel);
  }
  header h1 { font-size: 14px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  header .spacer { flex: 1; }
  button {
    background: var(--accent); color: #04121f; border: 0; border-radius: 6px;
    padding: 7px 16px; font-weight: 600; font-size: 13px; cursor: pointer;
  }
  button:disabled { opacity: .5; cursor: progress; }
  button.ghost {
    background: transparent; color: var(--dim); border: 1px solid var(--edge);
  }
  .status { font-size: 12px; color: var(--dim); font-family: var(--mono); }
  main { flex: 1; display: grid; grid-template-columns: 1fr 1fr; min-height: 0; }
  section { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  #editor { border-right: 1px solid var(--edge); }
  .label {
    padding: 6px 14px; font-size: 11px; text-transform: uppercase;
    letter-spacing: .8px; color: var(--dim); border-bottom: 1px solid var(--edge);
    background: var(--panel);
  }
  textarea {
    flex: 1; width: 100%; border: 0; outline: 0; resize: none; padding: 14px;
    background: var(--bg); color: var(--fg); font: 13px/1.6 var(--mono);
    tab-size: 2;
  }
  #output { flex: 1; overflow: auto; padding: 18px; }
  #logs {
    border-top: 1px solid var(--edge); background: var(--panel);
    max-height: 190px; overflow: auto; font: 12px/1.6 var(--mono);
    padding: 8px 14px; white-space: pre-wrap;
  }
  #logs:empty { display: none; }
  .log { color: var(--dim); }
  .log.warn { color: var(--warn); }
  .log.error { color: var(--err); }
  .errbox {
    background: rgba(248,81,73,.08); border: 1px solid rgba(248,81,73,.4);
    border-radius: 6px; padding: 12px; color: #ffa198; font: 12px/1.6 var(--mono);
    white-space: pre-wrap; margin-bottom: 14px;
  }
  .errbox b { color: var(--err); }
  #output h1 { font-size: 22px; margin: 0 0 6px; }
  .muted { color: var(--dim); margin: 0 0 16px; }
  #output ul { list-style: none; padding: 0; margin: 0; }
  #output li {
    display: flex; justify-content: space-between; padding: 8px 12px;
    background: var(--panel); border: 1px solid var(--edge);
    border-radius: 6px; margin-bottom: 6px;
  }
  #output li span { color: var(--dim); font-family: var(--mono); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>app-builder</h1>
  <button id="run">Update output</button>
  <button id="reset" class="ghost">Reset</button>
  <span class="spacer"></span>
  <span class="status" id="status">ready</span>
</header>
<main>
  <section id="editor">
    <div class="label">TypeScript</div>
    <textarea id="src" spellcheck="false" autocomplete="off"></textarea>
  </section>
  <section>
    <div class="label">Rendered output</div>
    <div id="output"></div>
    <div id="logs"></div>
  </section>
</main>
<script id="seed" type="application/json">${JSON.stringify(defaultCode).replace(/</g, "\\u003c")}</script>
<script>
  const src = document.getElementById("src");
  const out = document.getElementById("output");
  const logsEl = document.getElementById("logs");
  const status = document.getElementById("status");
  const runBtn = document.getElementById("run");
  const resetBtn = document.getElementById("reset");

  src.value = JSON.parse(document.getElementById("seed").textContent);
  if (!localStorage.getItem("ab:src")) localStorage.setItem("ab:src", src.value);
  else src.value = localStorage.getItem("ab:src");

  async function run() {
    runBtn.disabled = true;
    status.textContent = "running…";
    localStorage.setItem("ab:src", src.value);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: src.value }),
      });
      const data = await res.json();

      logsEl.innerHTML = "";
      for (const line of data.logs || []) {
        const div = document.createElement("div");
        div.className = "log " + line.split(" ")[0];
        div.textContent = line;
        logsEl.appendChild(div);
      }

      let banner = "";
      if (data.compileError) {
        banner = "<b>Compile error</b>\\n" + data.compileError.message;
      } else if (data.error) {
        banner = "<b>" + data.error.name + "</b>: " + data.error.message +
          (data.error.stack ? "\\n\\n" + data.error.stack : "");
      }
      out.innerHTML = banner
        ? '<div class="errbox">' + banner.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</div>" + (data.html || "")
        : data.html || '<span class="muted">(no output — end with an <code>html\`…\`</code> tag)</span>';

      status.textContent = data.ok
        ? "ok · " + data.durationMs + "ms"
        : "failed · " + data.durationMs + "ms";
    } catch (e) {
      status.textContent = "network error";
      out.innerHTML = '<div class="errbox">' + e.message + "</div>";
    } finally {
      runBtn.disabled = false;
    }
  }

  runBtn.addEventListener("click", run);
  resetBtn.addEventListener("click", () => {
    src.value = JSON.parse(document.getElementById("seed").textContent);
    run();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run();
  });
  run();
</script>
</body>
</html>`;

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
 * QuickJS runtime. A cookie rather than localStorage because cookies are keyed
 * on host alone: the port can change (proxies, preview hosts) and the session
 * must survive that.
 */
function resolveSession(req: Request): { id: string; isNew: boolean } {
  const fromCookie = readCookie(req, SESSION_COOKIE);
  if (fromCookie && /^[A-Za-z0-9_-]{8,64}$/.test(fromCookie)) return { id: fromCookie, isNew: false };
  const fromHeader = req.headers.get("x-ab-session");
  if (fromHeader && /^[A-Za-z0-9_-]{8,64}$/.test(fromHeader)) return { id: fromHeader, isNew: false };
  return { id: crypto.randomUUID(), isNew: true };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(page(DEFAULT_CODE), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/run" && req.method === "POST") {
      let body: { code?: string };
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: { message: "invalid JSON body" } }, { status: 400 });
      }
      const code = typeof body.code === "string" ? body.code : "";
      if (code.length > 200_000) {
        return Response.json(
          { error: { name: "TooLarge", message: "source exceeds 200,000 characters" } },
          { status: 413 },
        );
      }

      const session = resolveSession(req);
      const id = env.APP.idFromName(session.id);
      const result = await env.APP.get(id).run(code);

      const headers = new Headers({
        "content-type": "application/json; charset=utf-8",
      });
      // Secure is omitted so the cookie also works over plain http in local dev.
      if (session.isNew) {
        headers.append(
          "set-cookie",
          `${SESSION_COOKIE}=${session.id}; Path=/; Max-Age=31536000; SameSite=Lax`,
        );
      }
      headers.set("x-ab-session", session.id);
      return new Response(JSON.stringify(result satisfies RunResult), { headers });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;