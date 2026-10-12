import { AppSession, type ChatMessage, type FileMap } from "./session";
import { isSafePath } from "./paths";
import { agentTurn, MODEL, type AgentEvent } from "./agent";
import {
  createRepo,
  exchangeCode,
  getUser,
  listRepos,
  loginUrl,
  parseRepoRef,
  remoteUrl,
  requireEnv,
} from "./github";

export { AppSession };

export interface Env {
  APP: DurableObjectNamespace<AppSession>;
  OPENCODE_ZEN_KEY: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}


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

    /**
     * Build one source string without touching the session's files.
     *
     * The chat flow goes through `/api/build`, which reads what is in storage.
     * This is the stateless version, and it is what `scripts/smoke.mjs` and
     * `scripts/ui-check.mjs` post a throwaway program to. `state` still lives in
     * the Durable Object, so consecutive posts to the same cookie do share a VM.
     */
    if (url.pathname === "/api/run" && req.method === "POST") {
      let code: string;
      try {
        const body = (await req.json()) as { code?: string };
        if (typeof body.code !== "string") throw new Error("expected { code: string }");
        code = body.code;
      } catch (e) {
        return sessionJson({ error: { message: (e as Error).message } }, session, 400);
      }
      if (code.length > 200_000) {
        return sessionJson(
          { error: { name: "TooLarge", message: "source exceeds 200,000 characters" } },
          session,
          413,
        );
      }
      return sessionJson(await stub.run(code), session);
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

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const { message } = (await req.json()) as { message?: string };
      if (!message || !message.trim()) return sessionJson({ error: "empty message" }, session, 400);
      if (!env.OPENCODE_ZEN_KEY) {
        return sessionJson({ error: "OPENCODE_ZEN_KEY is not set on this Worker" }, session, 500);
      }

      // Adapter over the Durable Object so the agent can treat it as one object.
      const api = {
        getFiles: () => stub.getFiles(),
        setFiles: (f: FileMap) => stub.setFiles(f),
        getMessages: () => stub.getMessages(),
        setMessages: (m: ChatMessage[]) => stub.setMessages(m),
        build: (f?: FileMap) => stub.build(f),
        gitStatus: () => stub.gitStatus(),
        gitLog: () => stub.gitLog(),
        gitRun: (command: string) => stub.gitRun(command),
      };

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          const send = (event: AgentEvent) =>
            controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
          try {
            for await (const event of agentTurn(api, env.OPENCODE_ZEN_KEY, message)) send(event);
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

    // ---------- GitHub (OAuth + just-git, server-side) ----------

    if (url.pathname === "/api/github/status") {
      return sessionJson(await stub.getGitHubStatus(), session, 200, {
        "cache-control": "no-store",
      });
    }

    if (url.pathname === "/api/github/login") {
      try {
        const { clientId } = requireEnv(env as unknown as Record<string, string | undefined>);
        const redirectUri = `${url.origin}/api/github/callback`;
        // state carries the session id so the callback can store the token in
        // the right Durable Object even if the cookie is missing.
        const target = loginUrl({ clientId, redirectUri, state: session.id });
        return new Response(null, {
          status: 302,
          headers: withSession(new Headers({ location: target }), session),
        });
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    if (url.pathname === "/api/github/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state || !/^[A-Za-z0-9_-]{8,64}$/.test(state)) {
        return new Response("invalid oauth callback", { status: 400 });
      }
      try {
        const { clientId, clientSecret } = requireEnv(env as unknown as Record<string, string | undefined>);
        const redirectUri = `${url.origin}/api/github/callback`;
        const token = await exchangeCode({ clientId, clientSecret, code, redirectUri });
        const user = await getUser(token);
        const target = env.APP.get(env.APP.idFromName(state));
        await target.setGitHubToken(token, user);
        const headers = new Headers({ location: "/" });
        headers.append(
          "set-cookie",
          `${SESSION_COOKIE}=${state}; Path=/; Max-Age=31536000; SameSite=Lax`,
        );
        return new Response(null, { status: 302, headers });
      } catch (e) {
        return new Response(`github login failed: ${(e as Error).message}`, { status: 500 });
      }
    }

    if (url.pathname === "/api/github/logout" && req.method === "POST") {
      await stub.clearGitHub();
      return sessionJson({ ok: true }, session);
    }

    if (url.pathname === "/api/github/repos") {
      try {
        const token = await stub.getGitHubToken();
        if (!token) return sessionJson({ error: "not connected" }, session, 401);
        return sessionJson({ repos: await listRepos(token) }, session, 200, {
          "cache-control": "no-store",
        });
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    if (url.pathname === "/api/github/create" && req.method === "POST") {
      try {
        const { name, private: isPrivate, description, message } = (await req.json()) as {
          name?: string;
          private?: boolean;
          description?: string;
          message?: string;
        };
        if (!name || !name.trim()) return sessionJson({ error: "repo name is required" }, session, 400);
        const token = await stub.getGitHubToken();
        if (!token) return sessionJson({ error: "not connected" }, session, 401);
        const created = await createRepo(token, { name, private: isPrivate, description });
        const meta = {
          owner: created.owner,
          repo: created.name,
          branch: created.defaultBranch || "main",
          remoteUrl: remoteUrl(created.owner, created.name),
        };
        const pushed = await stub.pushCurrentToRemote({
          remoteUrl: meta.remoteUrl,
          meta,
          message: message || "initial commit from app-builder",
        });
        return sessionJson({ repo: created, meta, output: pushed.output, files: await stub.getFiles() }, session);
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    if (url.pathname === "/api/github/open" && req.method === "POST") {
      try {
        const { ref, branch } = (await req.json()) as { ref?: string; branch?: string };
        if (!ref || !ref.trim()) return sessionJson({ error: "owner/repo is required" }, session, 400);
        const { owner, repo } = parseRepoRef(ref);
        const cloned = await stub.cloneFromGitHub({ owner, repo, branch: branch?.trim() || undefined });
        const built = await stub.build();
        return sessionJson({ ...cloned, built }, session);
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    if (url.pathname === "/api/git/commit" && req.method === "POST") {
      try {
        const { message } = (await req.json()) as { message?: string };
        if (!message || !message.trim()) return sessionJson({ error: "commit message is required" }, session, 400);
        const r = await stub.commitPush(message.trim());
        return sessionJson({ ...r, status: await stub.gitStatus() }, session);
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    if (url.pathname === "/api/git/pull" && req.method === "POST") {
      try {
        const r = await stub.pullFromRemote();
        const built = await stub.build();
        return sessionJson({ ...r, built }, session);
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    if (url.pathname === "/api/git/status") {
      try {
        return sessionJson({ status: await stub.gitStatus() }, session, 200, {
          "cache-control": "no-store",
        });
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    if (url.pathname === "/api/git/log") {
      try {
        return sessionJson({ log: await stub.gitLog() }, session, 200, {
          "cache-control": "no-store",
        });
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    if (url.pathname === "/api/git/run" && req.method === "POST") {
      try {
        const { command } = (await req.json()) as { command?: string };
        if (!command || !command.trim()) return sessionJson({ error: "command is required" }, session, 400);
        const r = await stub.gitRun(command.trim());
        const built = await stub.build().catch(() => null);
        return sessionJson({ ...r, built }, session);
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
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
  /* Diagnostics: one block per error, tsc-shaped, with the span underlined. */
  .diag-wrap { white-space: normal; }
  .diag { margin-bottom: 12px; }
  .diag:last-child { margin-bottom: 0; }
  .diag-summary {
    color: var(--err); font-weight: 600; margin-bottom: 10px;
    padding-bottom: 8px; border-bottom: 1px solid rgba(255,123,114,.25);
  }
  .diag-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .diag-loc { color:#ffa39b; font-weight: 600; }
  .diag-cat { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  .diag-code {
    color: var(--err); background: rgba(255,123,114,.14); border-radius: 3px;
    padding: 1px 5px; font-size: 11px;
  }
  .diag.warning .diag-code { color: var(--warn); background: rgba(227,179,65,.14); }
  .diag-src { display: flex; gap: 10px; padding-left: 2px; }
  .diag-lineno { color: var(--dim); min-width: 2.5em; text-align: right; user-select: none; }
  .diag-text { color: var(--fg); white-space: pre; overflow-x: auto; }
  .diag-squiggle { color: var(--err); white-space: pre; }
  .diag.warning .diag-squiggle { color: var(--warn); }
  .diag-msg { color:#ffa39b; margin-top: 3px; white-space: pre-wrap; }
  .diag-rel { color: var(--dim); padding-left: 14px; margin-top: 3px;
              border-left: 2px solid var(--edge); }

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
  /* github panel */
  #gh { padding:22px 26px; max-width:640px; overflow:auto; height:100%; }
  #gh h2 { font-size:15px; margin:0 0 4px; }
  #gh p.hint { color:var(--dim); margin:0 0 14px; font-size:12.5px; }
  #gh .row { display:flex; gap:8px; align-items:center; margin:8px 0; flex-wrap:wrap; }
  #gh input[type=text] { background:var(--panel); border:1px solid var(--edge); border-radius:6px;
    color:var(--fg); padding:6px 9px; font:12.5px var(--sans); min-width:220px; }
  #gh button { background:var(--panel2); color:var(--fg); border:1px solid var(--edge);
    border-radius:6px; padding:6px 12px; font-size:12px; cursor:pointer; }
  #gh button.primary { background:var(--accent); color:#111; border:0; font-weight:600; }
  #gh button:disabled { opacity:.45; cursor:default; }
  #gh pre.out { background:var(--panel); border:1px solid var(--edge); border-radius:7px;
    padding:10px 12px; font:11.5px/1.6 var(--mono); white-space:pre-wrap; color:var(--dim);
    max-height:220px; overflow:auto; }
  #gh .repo { padding:6px 10px; border:1px solid var(--edge); border-radius:6px; margin:4px 0;
    cursor:pointer; color:var(--dim); font:12px var(--mono); }
  #gh .repo:hover { color:var(--fg); background:var(--panel2); }
</style>
</head>
<body>
<header>
  <span class="tab" data-view="code" role="tab">Code</span>
  <span class="tab" data-view="preview" role="tab" aria-selected="true">Preview</span>
  <span class="tab" data-view="resources" role="tab">Resources</span>
  <span class="tab" data-view="github" role="tab">GitHub</span>
  <span class="tab add">+</span>
  <div class="metrics">
    <span>process ram <b>—</b></span>
    <span>process cpu <b>—</b></span>
    <span>typecheck <b id="m-typecheck">—</b></span>
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

/**
 * Escape a value for interpolation into innerHTML.
 *
 * Diagnostics carry tsc's own message text and a line of the user's source, and
 * both routinely quote user code containing "<", so nothing here goes into
 * innerHTML unescaped.
 */
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * Spaces plus a tilde run, the same shape tsc's code frame uses.
 *
 * start and end are one-based columns into lineText. The line is used raw,
 * not trimmed: trimming would shift every underline left of where tsc says the
 * span is.
 */
const squiggle = (start, end, lineText) => {
  const len = Math.max(1, Math.min(end - start, Math.max(1, lineText.length - start + 1)));
  return " ".repeat(Math.max(0, start - 1)) + "~".repeat(len);
};

function renderDiagnostic(d) {
  const kind = d.category === "error" ? "error" : d.category;
  const code = d.code ? "TS" + d.code : "";
  let out =
    '<div class="diag ' + esc(kind) + '">' +
    '<div class="diag-head">' +
    '<span class="diag-loc">' + esc(d.file || "index.ts") + "(" + esc(d.line) + "," + esc(d.column) + ")</span>" +
    '<span class="diag-cat">' + esc(d.category) + "</span>" +
    (code ? '<span class="diag-code">' + esc(code) + "</span>" : "") +
    "</div>";

  const lines = d.sourceLines || [];
  const focus = lines.find((l) => l.line === d.line);
  if (focus) {
    out +=
      '<div class="diag-src">' +
      '<span class="diag-lineno">' + esc(focus.line) + "</span>" +
      '<span class="diag-text">' + esc(focus.text) + "</span></div>" +
      '<div class="diag-src">' +
      '<span class="diag-lineno"></span>' +
      '<span class="diag-squiggle">' +
      esc(squiggle(d.column, d.endColumn || d.column + 1, focus.text)) +
      "</span></div>";
  }

  out += '<div class="diag-msg">' + esc(d.text) + "</div>";

  for (const rel of d.related || []) {
    out +=
      '<div class="diag-rel">' +
      esc(rel.file || d.file) + "(" + esc(rel.line) + "," + esc(rel.column) + "): " +
      esc(rel.text) +
      "</div>";
  }

  return out + "</div>";
}

function renderDiagnostics(diagnostics) {
  const errors = diagnostics.filter((d) => d.category === "error");
  const others = diagnostics.length - errors.length;
  let head = "<b>" + errors.length + " type error" + (errors.length === 1 ? "" : "s") + "</b>";
  if (others) head += " and " + others + " warning" + (others === 1 ? "" : "s");
  return '<div class="diag-summary">' + head + "</div>" +
    diagnostics.map(renderDiagnostic).join("");
}
const log = document.getElementById("log");

// Surface script errors in the transcript. Without this a throw before the
// first render leaves the page silently idle.
window.addEventListener("error", (e) => {
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
const mBundle = document.getElementById("m-bundle");
const mTypecheck = document.getElementById("m-typecheck");
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
    // Type errors come first, because tsc is what rejects a program now and
    // everything after it is a program that never ran.
    const diags = built && built.diagnostics;
    if (diags && diags.length) {
      pane.appendChild(el("div", "banner diag-wrap", renderDiagnostics(diags)));
    } else if (built && built.typecheckError) {
      const tc = built.typecheckError;
      pane.appendChild(el("div", "banner",
        "Type checker failed: " + tc.name + ": " + tc.message +
        (tc.stderr ? "\\n\\n" + tc.stderr : "")));
    }
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
    } else if (!err && !(diags && diags.length) && !built?.typecheckError) {
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
  } else if (view === "github") {
    renderGitHub();
    return;
  } else if (view === "resources") {
    const d = el("div");
    d.className = "empty";
    d.style.whiteSpace = "pre-wrap";
    d.textContent = [
      "runtime     QuickJS (WASM) in a Durable Object",
      "typecheck   tsc 7 (ts-rust) compiled to WebAssembly, in the same DO",
      "compiler    sucrase (TypeScript -> JavaScript) to strip types before QuickJS",
      "model       " + MODEL + " via opencode zen",
      "state       persists per session, in the isolate",
      "",
      "process ram / cpu are not observable from inside a Worker,",
      "so they stay blank rather than showing invented numbers.",
      "the typecheck timing reads 0 on a deployed Worker because the",
      "runtime freezes the clock between I/O events; it is real under wrangler dev.",
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

/* ---------- github panel (just-git, server-side) ---------- */
let ghStatus = null;
let ghRepos = [];
let ghMsg = "";
let ghBusy = false;

async function ghRefreshStatus() {
  try {
    ghStatus = await fetch("/api/github/status", { cache: "no-store" }).then((r) => r.json());
  } catch (e) {
    ghMsg = "could not reach github status: " + (e.message || e);
  }
}

async function ghLoadRepos() {
  ghBusy = true; renderPane();
  try {
    const r = await fetch("/api/github/repos").then((r) => r.json());
    if (r.error) ghMsg = r.error;
    else { ghRepos = r.repos || []; ghMsg = ghRepos.length ? "" : "no repos found"; }
  } catch (e) { ghMsg = "repo list failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

function ghNote(t) { ghMsg = t; renderPane(); }

async function ghOpen(ref, branch) {
  ghBusy = true; ghMsg = "cloning " + ref + "…"; renderPane();
  try {
    const r = await fetch("/api/github/open", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref, branch }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    files = r.files || files;
    activeFile = files["index.ts"] ? "index.ts" : Object.keys(files).sort()[0];
    built = r.built;
    setMetrics(built);
    await ghRefreshStatus();
    ghMsg = "opened " + ref + (r.skipped && r.skipped.length ? " (skipped: " + r.skipped.join(", ") + ")" : "") +
      ". Not previewable? Edit files in Code, then commit below.";
  } catch (e) { ghMsg = "open failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghCreate(name, isPrivate, message) {
  ghBusy = true; ghMsg = "creating " + name + " and pushing…"; renderPane();
  try {
    const r = await fetch("/api/github/create", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, private: isPrivate, message }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    await ghRefreshStatus();
    ghMsg = "created " + r.repo.fullName + " and pushed. " + (r.output || "").slice(0, 300);
  } catch (e) { ghMsg = "create failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghCommitPush(message) {
  ghBusy = true; ghMsg = "committing and pushing…"; renderPane();
  try {
    const r = await fetch("/api/git/commit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    ghMsg = "pushed. " + (r.output || "").slice(0, 500);
  } catch (e) { ghMsg = "push failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghPull() {
  ghBusy = true; ghMsg = "pulling…"; renderPane();
  try {
    const r = await fetch("/api/git/pull", { method: "POST" }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    files = r.files || files;
    built = r.built;
    setMetrics(built);
    ghMsg = "pulled. " + (r.output || "").slice(0, 500);
  } catch (e) { ghMsg = "pull failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghShow(which) {
  ghBusy = true; renderPane();
  try {
    const r = await fetch("/api/git/" + which, { cache: "no-store" }).then((r) => r.json());
    ghMsg = (which === "status" ? (r.status || r.error) : (r.log || r.error)) || "(empty)";
  } catch (e) { ghMsg = which + " failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghRunCmd(cmd) {
  ghBusy = true; ghMsg = "running git " + cmd + "…"; renderPane();
  try {
    const r = await fetch("/api/git/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: cmd }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    if (r.files) files = r.files;
    if (r.built) { built = r.built; setMetrics(built); }
    ghMsg = "$ git " + cmd + "\\n" + ((r.stdout || "") + "\\n" + (r.stderr || "")).trim().slice(0, 2000) || "(no output)";
  } catch (e) { ghMsg = "git run failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

function renderGitHub() {
  const wrap = el("div");
  wrap.id = "gh";
  wrap.appendChild(el("h2", null, "GitHub"));
  wrap.appendChild(el("p", "hint",
    "Log in, then create a repo from the current files or open one to edit here. " +
    "Clones that have no runnable index.ts still edit and push fine — Preview just shows the type error."));
  if (!ghStatus) {
    wrap.appendChild(el("p", "hint", "loading…"));
    pane.appendChild(wrap);
    ghRefreshStatus().then(renderPane);
    return;
  }
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
    const out = el("button", null, "Log out");
    out.onclick = async () => {
      await fetch("/api/github/logout", { method: "POST" });
      ghStatus = null; ghRepos = [];
      await ghRefreshStatus(); renderPane();
    };
    who.appendChild(out);
    wrap.appendChild(who);
  }
  if (ghStatus && ghStatus.connected) {
    const linked = ghStatus.linked;
    wrap.appendChild(el("p", "hint",
      linked ? ("linked: " + linked.owner + "/" + linked.repo + " (" + linked.branch + ")") : "no repo linked yet"));
    // open
    const orow = el("div", "row");
    const ref = document.createElement("input");
    ref.type = "text"; ref.placeholder = "owner/repo";
    const br = document.createElement("input");
    br.type = "text"; br.placeholder = "branch (optional)"; br.style.minWidth = "130px";
    const openBtn = el("button", "primary", "Open repo");
    openBtn.disabled = ghBusy;
    openBtn.onclick = () => ghOpen(ref.value, br.value || undefined);
    orow.appendChild(ref); orow.appendChild(br); orow.appendChild(openBtn);
    wrap.appendChild(orow);
    // create
    const crow = el("div", "row");
    const nm = document.createElement("input");
    nm.type = "text"; nm.placeholder = "new repo name";
    const priv = document.createElement("input");
    priv.type = "checkbox"; priv.title = "private";
    const createBtn = el("button", null, "Create + push current code");
    createBtn.disabled = ghBusy;
    createBtn.onclick = () => ghCreate(nm.value.trim(), priv.checked, "initial commit from app-builder");
    crow.appendChild(nm); crow.appendChild(priv);
    crow.appendChild(el("span", "hint", "private"));
    crow.appendChild(createBtn);
    wrap.appendChild(crow);
    // repos
    const lrow = el("div", "row");
    const lb = el("button", null, "List my repos");
    lb.disabled = ghBusy;
    lb.onclick = ghLoadRepos;
    lrow.appendChild(lb);
    wrap.appendChild(lrow);
    for (const r of ghRepos.slice(0, 20)) {
      const d = el("div", "repo", (r.private ? "🔒 " : "") + r.fullName);
      d.onclick = () => ghOpen(r.fullName, undefined);
      wrap.appendChild(d);
    }
    // commit / pull / status / log / run
    const mrow = el("div", "row");
    const msg = document.createElement("input");
    msg.type = "text"; msg.placeholder = "commit message";
    const pushBtn = el("button", "primary", "Commit + push");
    pushBtn.disabled = ghBusy;
    pushBtn.onclick = () => ghCommitPush(msg.value);
    const pullBtn = el("button", null, "Pull");
    pullBtn.disabled = ghBusy;
    pullBtn.onclick = ghPull;
    mrow.appendChild(msg); mrow.appendChild(pushBtn); mrow.appendChild(pullBtn);
    wrap.appendChild(mrow);
    const qrow = el("div", "row");
    const items = [["status", "Status"], ["log", "Log"]];
    for (const pair of items) {
      const b = el("button", null, pair[1]);
      b.disabled = ghBusy;
      b.onclick = ((w) => () => ghShow(w))(pair[0]);
      qrow.appendChild(b);
    }
    const cmd = document.createElement("input");
    cmd.type = "text"; cmd.placeholder = "git args, e.g. diff --stat";
    const runB = el("button", null, "Run git");
    runB.disabled = ghBusy;
    runB.onclick = () => ghRunCmd(cmd.value);
    qrow.appendChild(cmd); qrow.appendChild(runB);
    wrap.appendChild(qrow);
  }
  if (ghMsg) {
    const pre = el("pre", "out", ghMsg);
    wrap.appendChild(pre);
  }
  pane.appendChild(wrap);
}

function setMetrics(b) {
  mBundle.textContent = b && b.durationMs != null ? b.durationMs + " ms" : "—";
  // Local-dev reading only: Workers freezes Date.now() and performance.now()
  // between I/O events, so on a deployed Worker this reads 0. It is here because
  // under wrangler dev it is the number that tells you whether the gate is
  // worth keeping, not because it is a production metric.
  mTypecheck.textContent = b && b.typecheckMs != null ? b.typecheckMs + " ms" : "—";
  if (!b) { mBuilt.textContent = "idle"; mBuilt.className = "built"; return; }
  const bad = !b.ok || b.compileError || (b.diagnostics && b.diagnostics.length);
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