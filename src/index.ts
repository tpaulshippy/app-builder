import { AppSession, type ChatMessage, type FileMap } from "./session";
import { isSafePath } from "./paths";
import { agentTurn, DEFAULT_GATEWAY, DEFAULT_MODEL, GO_MODELS, ZEN_MODELS, type AgentEvent } from "./agent";
import { APP_SHIM_JS } from "./app-shim";
import { buildAppBundle } from "./lakebed";
import type { AppKind, AppState } from "./app-runtime";

export interface Env {
  APP: DurableObjectNamespace<AppSession>;
  /** Server-side fallback; browsers normally send their own key per request. */
  OPENCODE_ZEN_KEY?: string;
  /** Owned lakebed deploys; anonymous when unset. */
  LAKEBED_TOKEN?: string;
}

export { AppSession };

const SESSION_COOKIE = "ab_session";
const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The app view iframe runs sandboxed with an opaque origin, so it cannot use
 * the session cookie (and must never see the parent page). It addresses its
 * Durable Object with an explicit `sid` instead. Same unguessable random id
 * the cookie already carries, same no-auth posture as the rest of this app.
 */
const APP_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept",
};

const corsJson = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...APP_CORS, ...extra }),
  });

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Full document for the live app iframe: boot state plus the client bundle. */
const appDoc = (
  bundle: string | null,
  boot: { sid: string; api: { state: string; mutate: string }; state: unknown; error: unknown },
): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>capsule app</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing:border-box; }
  body { margin:0; background:#08090a; color:#e8eaeb;
         font:14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; padding:20px 20px 40px; }
  h1 { font-size:22px; letter-spacing:-.2px; }
  button { background:#d8f06a; color:#111; border:0; border-radius:8px; padding:10px 16px;
           font-weight:600; font-size:14px; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  input, textarea, select { background:#0e1011; color:#e8eaeb; border:1px solid #232627;
           border-radius:8px; padding:9px 11px; font:inherit; }
  ul { padding-left:1.2em; } li { margin:4px 0; }
  pre { white-space:pre-wrap; overflow-wrap:anywhere; }
  .app-error { font:12px/1.6 ui-monospace, monospace; color:#ffa39b; white-space:pre-wrap; }
  @media (pointer:coarse), (max-width:768px) {
    body { padding:16px 16px 32px; }
    input, textarea, select, button { font-size:16px; }
  }
</style>
</head>
<body>
<div id="app">${bundle === null ? `<main><h1>App failed to build</h1><pre class="app-error">${escHtml((boot.error as { message?: string } | null)?.message ?? "unknown error")}</pre></main>` : "<main>Loading…</main>"}</div>
<script>window.__APP_BOOT__ = ${JSON.stringify(boot).replace(/</g, "\\u003c")};</script>
${bundle === null ? "" : `<script type="module">${bundle.replace(/<\/script/gi, "<\\/script")}</script>`}
</body>
</html>`;

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
      if (!isSafePath(key)) {
        return sessionJson({ error: "unsafe path" }, session, 400);
      }
      files[key] = content ?? "";
      await stub.setFiles(files);
      return sessionJson({ files, built: await stub.build() }, session);
    }

    if (url.pathname === "/api/reset" && req.method === "POST") {
      return sessionJson(await stub.reset(), session);
    }

    if (url.pathname === "/api/app-shim.js") {
      return new Response(APP_SHIM_JS, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=3600",
          ...APP_CORS,
        },
      });
    }

    // Live app view endpoints. The iframe is sandboxed to an opaque origin,
    // so these address the session explicitly and allow CORS instead of
    // relying on the cookie. See APP_CORS.
    if (url.pathname === "/api/app-state" || url.pathname === "/api/app-mutate") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: APP_CORS });
    }

    if (url.pathname === "/api/app-state") {
      const sid = url.searchParams.get("sid") ?? "";
      if (!SID_RE.test(sid)) return corsJson({ ok: false, error: { name: "Session", message: "bad sid" } }, 400);
      return corsJson(await env.APP.get(env.APP.idFromName(sid)).appState());
    }

    if (url.pathname === "/api/app-mutate" && req.method === "POST") {
      let body: { sid?: unknown; kind?: unknown; name?: unknown; args?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return corsJson({ ok: false, error: { name: "Request", message: "expected a JSON body" } }, 400);
      }
      if (typeof body.sid !== "string" || !SID_RE.test(body.sid)) {
        return corsJson({ ok: false, error: { name: "Session", message: "bad sid" } }, 400);
      }
      if (body.kind !== "mutation" && body.kind !== "action") {
        return corsJson({ ok: false, error: { name: "Request", message: "kind must be mutation or action" } }, 400);
      }
      if (typeof body.name !== "string" || !body.name) {
        return corsJson({ ok: false, error: { name: "Request", message: "name must be a non-empty string" } }, 400);
      }
      if (body.args !== undefined && !Array.isArray(body.args)) {
        return corsJson({ ok: false, error: { name: "Request", message: "args must be an array" } }, 400);
      }
      const kind: AppKind = body.kind;
      return corsJson(
        await env.APP.get(env.APP.idFromName(body.sid)).appMutate(kind, body.name, body.args ?? []),
      );
    }

    if (url.pathname === "/api/app") {
      const sid = url.searchParams.get("sid") ?? "";
      if (!SID_RE.test(sid)) return new Response("bad sid", { status: 400 });
      const appStub = env.APP.get(env.APP.idFromName(sid));
      const appFiles = await appStub.getFiles();
      // The RPC stub type does not preserve the discriminated union, so
      // restore it: at runtime this is plain data in exactly this shape.
      const state = (await appStub.appState()) as AppState;
      let bundle: string | null;
      let bundleError: string | null = null;
      try {
        bundle = buildAppBundle(appFiles, `${url.origin}/api/app-shim.js`);
      } catch (e: any) {
        bundle = null;
        bundleError = e?.message ?? String(e);
      }
      return new Response(
        appDoc(bundle, {
          sid,
          api: { state: `${url.origin}/api/app-state`, mutate: `${url.origin}/api/app-mutate` },
          state: state.ok ? { tables: state.tables, queries: state.queries } : null,
          error: state.ok ? (bundleError ? { message: bundleError } : null) : state.error,
        }),
        {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        },
      );
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const { message, key, gateway, model } = (await req.json()) as {
        message?: string;
        key?: string;
        gateway?: string;
        model?: string;
      };
      if (!message || !message.trim()) return sessionJson({ error: "empty message" }, session, 400);
      // BYOK: the browser holds the caller's key in localStorage and sends it
      // with each request. The Worker secret is only a fallback.
      const apiKey =
        req.headers.get("x-provider-key")?.trim() || key?.trim() || env.OPENCODE_ZEN_KEY?.trim();
      if (!apiKey) {
        return sessionJson(
          { error: "no API key — enter one below (stored only in this browser)" },
          session,
          401,
        );
      }

      // Adapter over the Durable Object so the agent can treat it as one object.
      const api = {
        getFiles: () => stub.getFiles(),
        setFiles: (f: FileMap) => stub.setFiles(f),
        getMessages: () => stub.getMessages(),
        setMessages: (m: ChatMessage[]) => stub.setMessages(m),
        build: (f?: FileMap) => stub.build(f),
        exec: (command: string, f?: FileMap) => stub.exec(command, f),
      };

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          const send = (event: AgentEvent) =>
            controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
          try {
            for await (const event of agentTurn(api, apiKey, message, { gateway, model })) send(event);
          } catch (e) {
            send({ type: "error", message: e instanceof Error ? e.message : String(e) });
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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
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
  body { background:var(--bg); color:var(--fg); font:13px/1.55 var(--sans); display:flex; flex-direction:column; overflow:hidden;
         height:100vh; height:100dvh; }

  /* top bar */
  header { display:flex; align-items:center; gap:2px; padding:0 10px; min-height:38px;
           border-bottom:1px solid var(--edge); background:var(--panel); flex:0 0 auto;
           overflow-x:auto; scrollbar-width:none; white-space:nowrap; }
  header::-webkit-scrollbar { display:none; }
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
  #apikey { flex:1; min-width:0; border:0; outline:0; background:transparent; color:var(--dim);
            font:11px/1.5 var(--mono); }
  #apikey::placeholder { color:var(--faint); }
  #gateway, #model { background:var(--panel2); color:var(--dim); border:1px solid var(--edge);
            border-radius:6px; padding:4px 6px; font:11px/1.5 var(--mono); max-width:220px; }
  #model { flex:1; min-width:0; }

  /* right pane */
  #right { display:flex; flex-direction:column; min-width:0; min-height:0; }
  .subtabs { display:flex; gap:2px; padding:6px 10px; border-bottom:1px solid var(--edge);
             background:var(--panel); flex:0 0 auto; }
  #pane { flex:1; overflow-y:auto; overflow-x:hidden; position:relative; }
  #appwrap { position:absolute; inset:0; }
  #appwrap iframe { width:100%; height:100%; border:0; display:block; background:#08090a; }
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
  /* type errors never block the build, so they get their own amber strip
     rather than reusing the red build-failure banner. */
  .diag { background:rgba(227,179,65,.07); border:1px solid rgba(227,179,65,.35);
            border-radius:7px; padding:11px 13px; color:#e8d5a2; font:12px/1.6 var(--mono);
            white-space:pre-wrap; margin:12px 16px 0; }
  .diag b { color:var(--warn); }

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

  /* iOS Safari auto-zooms on focus when the field is <16px. Keep 16px on touch. */
  @media (pointer:coarse), (max-width:768px) {
    #input, #apikey, #editor { font-size:16px; }
  }

  /* Narrow screens (iPhone SE is 375px): stack chat above the pane, hide
     non-essential header stats, enlarge touch targets, respect the notch. */
  @media (max-width:768px) {
    header { padding-top:env(safe-area-inset-top); }
    .metrics { gap:10px; }
    .metrics span:not(#m-built) { display:none; }
    .tab.add { display:none; }
    .tab { padding:10px 12px; }
    main { display:flex; flex-direction:column; }
    #chat { flex:1 1 42%; border-right:0; border-bottom:1px solid var(--edge); min-height:0; }
    #right { flex:1 1 58%; min-height:0; }
    #composer { padding-bottom:calc(8px + env(safe-area-inset-bottom)); }
    #send { width:44px; height:44px; font-size:18px; border-radius:10px; }
    #preview { padding:16px; }
    .banner { margin:0 16px 12px; }
    #code { grid-template-columns:1fr; grid-template-rows:auto 1fr; }
    #tree { display:flex; overflow-x:auto; border-right:0; border-bottom:1px solid var(--edge); padding:4px 6px; }
    #tree div { white-space:nowrap; padding:10px 12px; }
    #savebar { right:12px; bottom:12px; }
    #save { padding:12px 18px; font-size:13px; }
  }
</style>
</head>
<body>
<header>
  <span class="tab" data-view="code" role="tab" tabindex="0">Code</span>
  <span class="tab" data-view="preview" role="tab" tabindex="0" aria-selected="true">Preview</span>
  <span class="tab" data-view="resources" role="tab" tabindex="0">Resources</span>
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
        <textarea id="input" placeholder="What do you want to build?" rows="2" enterkeyhint="send"></textarea>
        <div class="crow">
          <select id="gateway" title="Gateway">
            <option value="zen">zen</option>
            <option value="go">go</option>
          </select>
          <select id="model" title="Model"></select>
          <button id="send" title="Send">↑</button>
        </div>
        <div class="crow">
          <input id="apikey" type="password" autocomplete="off" spellcheck="false"
            placeholder="API key (stored only in this browser)" />
        </div>
      </div>
    </div>
  </section>
  <section id="right">
    <div class="subtabs">
      <span class="tab" data-pane="preview" tabindex="0" aria-selected="true">Preview</span>
      <span class="tab" data-pane="database" tabindex="0">Database</span>
      <span class="tab" data-pane="logs" tabindex="0">Logs</span>
    </div>
    <div id="pane"></div>
  </section>
</main>
<script>
const GATEWAYS = { zen: ${JSON.stringify(ZEN_MODELS)}, go: ${JSON.stringify(GO_MODELS)} };
const DEFAULT_GATEWAY = ${JSON.stringify(DEFAULT_GATEWAY)};
const DEFAULT_MODEL = ${JSON.stringify(DEFAULT_MODEL)};
const log = document.getElementById("log");

// Surface script errors in the transcript. Without this a throw before the
// first render leaves the page silently idle.
window.addEventListener("error", (e) => {
  // Third-party scripts injected into the page (wallet shims, extensions,
  // antivirus/proxy injectors) run cross-origin, so their throws reach us
  // sanitized as "Script error." with no file or line. Our own inline script
  // always reports a filename, so a filenameless "Script error." cannot be
  // ours. Not actionable — drop it instead of alarming the transcript.
  if (e.message === "Script error." && !e.filename) {
    console.debug("ignored cross-origin script error");
    return;
  }
  const msg = e.message || String(e.error);
  // Brave on iOS injects a wallet script into every page that throws on
  // "window.ethereum.selectedAddress = undefined" because no provider is
  // injected. Not ours, not actionable. brave-ios#6656.
  if (msg.includes("ethereum.selectedAddress")) return;
  const n = document.createElement("div");
  n.className = "err";
  n.textContent = "js error: " + msg;
  log.appendChild(n);
});
const pane = document.getElementById("pane");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const keyInput = document.getElementById("apikey");
keyInput.value = localStorage.getItem("ab_key") || "";
const gatewaySel = document.getElementById("gateway");
const modelSel = document.getElementById("model");
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
gatewaySel.value = localStorage.getItem("ab_gateway") || DEFAULT_GATEWAY;
if (!GATEWAYS[gatewaySel.value]) gatewaySel.value = DEFAULT_GATEWAY;
fillModels(gatewaySel.value, localStorage.getItem("ab_model") || DEFAULT_MODEL);
gatewaySel.onchange = () => {
  localStorage.setItem("ab_gateway", gatewaySel.value);
  fillModels(gatewaySel.value, modelSel.value);
  localStorage.setItem("ab_model", modelSel.value);
};
modelSel.onchange = () => localStorage.setItem("ab_model", modelSel.value);
const mBundle = document.getElementById("m-bundle");
const mBuilt = document.getElementById("m-built");

let view = "preview";
let inner = "preview";
let files = { "server/index.ts": "" };
let activeFile = "server/index.ts";
let built = null;
let busy = false;
// Bumped on every successful build so the app iframe reloads against fresh
// files. The iframe is otherwise left alone (remounts wipe its UI state).
let appV = 0;

const sessionId = () => {
  const m = document.cookie.match(/(?:^|; *)ab_session=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "";
};

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
  const m = el("div", "model", "✳ " + gatewaySel.value + "/" + modelSel.value);
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
  if (view === "code") {
    renderCode();
    return;
  }
  if (inner === "preview") {
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
        const frame = document.createElement("iframe");
        frame.id = "appframe";
        frame.title = "Capsule app";
        frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.src = "/api/app?sid=" + encodeURIComponent(sid) + "&v=" + appV;
        wrap.appendChild(frame);
      }
      pane.appendChild(wrap);
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
    // Live database state behind the app view (the app's own writes land
    // here), fetched from the isolate — not the last build snapshot.
    const loading = el("div", "empty", "Loading live state…");
    pane.appendChild(loading);
    const sid = sessionId();
    if (!sid) {
      loading.textContent = "Session not ready — reload the page.";
    } else {
      fetch("/api/app-state?sid=" + encodeURIComponent(sid), { cache: "no-store" })
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
    }
  } else if (view === "resources") {
    const d = el("div");
    d.className = "empty";
    d.style.whiteSpace = "pre-wrap";
    d.textContent = [
      "runtime     QuickJS (WASM) + just-bash in a Durable Object",
      "capsule     lakebed server stub with in-memory db (dev semantics)",
      "deploy      lakebed anonymous API (owned with LAKEBED_TOKEN)",
      "model       " + gatewaySel.value + "/" + modelSel.value + " (BYOK, kept in browser local storage)",
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
  if (b && b.ok) appV++;
  mBundle.textContent = b && b.durationMs != null ? b.durationMs + " ms" : "—";
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
    ? \`\${diags.length} type error\${diags.length === 1 ? "" : "s"} — the preview above still runs; lint blocks deploy until these are fixed\`
    : "type checker did not finish"));
  d.appendChild(document.createTextNode("\\n" + lines.join("\\n")));
  return d;
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

  const apiKey = (keyInput.value || localStorage.getItem("ab_key") || "").trim();
  if (keyInput.value.trim()) localStorage.setItem("ab_key", keyInput.value.trim());
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { "x-provider-key": apiKey } : {}) },
      body: JSON.stringify({ message: text, gateway: gatewaySel.value, model: modelSel.value }),
    });
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "unauthorized: set the API key below");
    }
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

function syncTabs() {
  document.querySelectorAll("[data-view]").forEach((o) => {
    if (o.dataset.view === view) o.setAttribute("aria-selected", "true");
    else o.removeAttribute("aria-selected");
  });
  document.querySelectorAll("[data-pane]").forEach((o) => {
    if (o.dataset.pane === inner) o.setAttribute("aria-selected", "true");
    else o.removeAttribute("aria-selected");
  });
}
function selectTab(elm) {
  view = elm.dataset.view ?? elm.dataset.pane;
  inner = elm.dataset.pane ?? elm.dataset.view;
  syncTabs();
  renderPane();
}
document.querySelectorAll("[data-view]").forEach((n) => {
  n.onclick = () => selectTab(n);
  n.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectTab(n); } };
});
document.querySelectorAll("[data-pane]").forEach((n) => {
  n.onclick = () => selectTab(n);
  n.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectTab(n); } };
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