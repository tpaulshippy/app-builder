import { AppSession, type ChatMessage, type FileMap } from "./session";
import { isSafePath } from "./paths";
import { DEFAULT_GATEWAY, DEFAULT_MODEL, GO_MODELS, ZEN_MODELS } from "./agent";
import { APP_SHIM_JS } from "./app-shim";
import { buildAppBundle } from "./lakebed";
import type { AppKind, AppState } from "./app-runtime";
import {
  createRepo,
  deleteRepo,
  exchangeCode,
  getUser,
  listRepos,
  loginUrl,
  parseRepoRef,
  remoteUrl,
  requireEnv,
} from "./github";
import { isWorktreeKey } from "./gitops";

export interface Env {
  APP: DurableObjectNamespace<AppSession>;
  /** Server-side fallback; browsers normally send their own key per request. */
  OPENCODE_ZEN_KEY?: string;
  /** Owned lakebed deploys; anonymous when unset. */
  LAKEBED_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
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
  html, body { max-width:100%; overflow-x:clip; }
  body { margin:0; background:#08090a; color:#e8eaeb;
         font:14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; padding:20px 20px 40px; }
  #app, main { min-width:0; max-width:100%; }
  img, video, canvas, table { max-width:100%; height:auto; }
  table { display:block; overflow-x:auto; }
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
      // Same clobber hazard as the bulk save: read-mutate-write of the whole
      // map races an agent turn's write_file persists.
      if (await stub.isTurnActive()) {
        return sessionJson(
          { error: "an agent turn is in progress — wait for it to finish, then retry" },
          session,
          409,
        );
      }
      const { path, content } = (await req.json()) as { path?: string; content?: string };
      const files = { ...(await stub.getFiles()) };
      const key = (path ?? "").trim() || "index.ts";
      if (!isSafePath(key)) {
        return sessionJson({ error: "unsafe path" }, session, 400);
      }
      if (!isWorktreeKey(key)) {
        return sessionJson({ error: "refused path inside .git" }, session, 400);
      }
      files[key] = content ?? "";
      await stub.setFiles(files);
      return sessionJson({ files, built: await stub.build() }, session);
    }

    if (url.pathname === "/api/reset" && req.method === "POST") {
      return sessionJson(await stub.reset(), session);
    }

    // Clear agent context only; capsule files are left untouched. The chat
    // transcript persists per session in the Durable Object, so without this
    // a refresh restores an invisible history that still consumes context.
    if (url.pathname === "/api/clear-chat" && req.method === "POST") {
      await stub.clearChat();
      return sessionJson({ ok: true }, session);
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

    // Pi boot probe (no key needed): forwards to the object's /pi-status.
    if (url.pathname === "/api/pi-harness-status" && req.method === "GET") {
      const res = await stub.fetch(new Request(new URL("/pi-status", url.origin), { method: "GET" }));
      const headers = withSession(new Headers(res.headers), session);
      // Probes must never cache: busyflips live while runs come and go.
      headers.set("cache-control", "no-store");
      return new Response(res.body, { status: res.status, headers });
    }

    // The agent loop runs in Pi (Durable Object PiHarness): validate and
    // resolve BYOK at the edge, forward to the object, stream its SSE back
    // with the session cookie.
    if (url.pathname === "/api/chat" && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return sessionJson({ error: "expected a JSON body" }, session, 400);
      }
      if (!body || typeof body !== "object") {
        return sessionJson({ error: "expected a JSON body" }, session, 400);
      }
      const { message, key, gateway, model } = body as {
        message?: unknown;
        key?: string;
        gateway?: string;
        model?: string;
      };
      if (typeof message !== "string" || !message.trim()) {
        return sessionJson({ error: "empty message" }, session, 400);
      }
      const bodyKey = typeof key === "string" ? key.trim() : "";
      const apiKey =
        req.headers.get("x-provider-key")?.trim() || bodyKey || env.OPENCODE_ZEN_KEY?.trim();
      if (!apiKey) {
        return sessionJson(
          { error: "no API key — enter one below (stored only in this browser)" },
          session,
          401,
        );
      }
      // withSession: the forwarded DO response carries no cookies, so a
      // first request must still set ab_session or the next request lands
      // on another object. A rejected forward (dead object, RPC failure)
      // still answers as an SSE error frame with the cookie, never a bare
      // 500 that also drops the session.
      let res: Response;
      try {
        res = await stub.fetch(
          new Request(new URL("/pi-harness", url.origin), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message, apiKey, gateway, model }),
          }),
        );
      } catch (e) {
        const frame = `data: ${JSON.stringify({ type: "error", message: e instanceof Error ? e.message : String(e) })}\n\n`;
        return new Response(frame, {
          headers: withSession(
            new Headers({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" }),
            session,
          ),
        });
      }
      const headers = withSession(new Headers(res.headers), session);
      return new Response(res.body, { status: res.status, headers });
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
      // Login CSRF / session fixation guard: `state` is the session id sent in
      // the authorize URL, so only honor it when it matches the browser's own
      // session cookie. The login redirect sets that cookie (even for new
      // sessions), so a same-browser flow always round-trips; a crafted link
      // opened by a victim carries the attacker's state but the victim's
      // cookie and is rejected here before any token is stored.
      if (readCookie(req, SESSION_COOKIE) !== state) {
        return new Response("session mismatch — start login again from the GitHub tab", { status: 400 });
      }
      try {
        const { clientId, clientSecret } = requireEnv(env as unknown as Record<string, string | undefined>);
        const redirectUri = `${url.origin}/api/github/callback`;
        const { token, grantedScopes } = await exchangeCode({ clientId, clientSecret, code, redirectUri });
        const user = await getUser(token);
        const target = env.APP.get(env.APP.idFromName(state));
        await target.setGitHubToken(token, user, grantedScopes);
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

    // Bulk-save the editor's in-memory file map without building. The panel
    // calls this before commit/create so unsaved browser edits are not
    // silently omitted from the push.
    if (url.pathname === "/api/files" && req.method === "POST") {
      try {
        // The browser snapshot can lag an active agent turn; replacing the
        // whole FileMap then would discard already-persisted agent edits.
        if (await stub.isTurnActive()) {
          return sessionJson(
            { error: "an agent turn is in progress — wait for it to finish, then retry" },
            session,
            409,
          );
        }
        const { files: incoming } = (await req.json()) as { files?: FileMap };
        if (!incoming || typeof incoming !== "object") {
          return sessionJson({ error: "expected { files }" }, session, 400);
        }
        for (const key of Object.keys(incoming)) {
          if (!isWorktreeKey(key) || typeof incoming[key] !== "string") {
            return sessionJson({ error: `refused path: ${key}` }, session, 400);
          }
        }
        await stub.setFiles({ ...incoming });
        return sessionJson({ files: await stub.getFiles() }, session);
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
        try {
          const pushed = await stub.pushCurrentToRemote({
            remoteUrl: meta.remoteUrl,
            meta,
            message: message || "initial commit from app-builder",
          });
          return sessionJson({ repo: created, meta, output: pushed.output, files: await stub.getFiles() }, session);
        } catch (pushErr) {
          // The repo already exists at this point: say so explicitly, and
          // remove the empty shell so a retry does not collide with it.
          let cleaned = false;
          try {
            await deleteRepo(token, created.owner, created.name);
            cleaned = true;
          } catch {
            /* report below; the repo stays for manual deletion */
          }
          return sessionJson(
            {
              error:
                `repo ${created.fullName} was created but the initial push failed: ${(pushErr as Error).message}` +
                (cleaned ? " The empty repo was deleted, so retrying is safe." : " Delete it on GitHub before retrying."),
            },
            session,
            500,
          );
        }
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
        if (r.conflict) {
          // 409, but still with the conflict-marked files: the editor must
          // receive the markers it is told to resolve.
          return sessionJson({ ...r, built }, session, 409);
        }
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
        // A non-capsule repo will not build: still return the git result and
        // let the panel show the build error alongside it.
        let built: unknown = null;
        try {
          built = await stub.build();
        } catch {
          built = { ok: false, error: { name: "Build", message: "repo does not build as a capsule" } };
        }
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

  /* single-pane layout: one tab visible at a time */
  main { flex:1; display:flex; flex-direction:column; min-height:0; min-width:0; }
  #chat[hidden], #pane[hidden] { display:none; }

  /* chat view */
  #chat { flex:1; border:0; display:flex; flex-direction:column; min-height:0; min-width:0; background:var(--bg); }
  #chathdr, #log, #composer { width:100%; max-width:880px; margin-left:auto; margin-right:auto; }
  #chathdr { display:flex; align-items:center; gap:8px; padding:8px 14px 0; flex:0 0 auto;
             font:10px/1 var(--mono); text-transform:uppercase; letter-spacing:1px; color:var(--faint); }
  #newchat { margin-left:auto; background:transparent; color:var(--dim); border:1px solid var(--edge);
             border-radius:6px; padding:4px 9px; font:10.5px/1.4 var(--mono); cursor:pointer; }
  #newchat:hover { color:var(--fg); border-color:#3a4043; }
  #newchat:disabled { opacity:.4; cursor:default; }
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
  #box { border:1px solid var(--edge); border-radius:10px; background:var(--panel); padding:9px 10px 7px;
         min-width:0; overflow:hidden; }
  #input { width:100%; border:0; outline:0; resize:none; background:transparent; color:var(--fg);
           font:13px/1.5 var(--sans); min-height:38px; max-height:140px; }
  #input::placeholder { color:var(--faint); }
  .crow { display:flex; align-items:center; gap:8px; margin-top:4px; min-width:0; flex-wrap:wrap; }
  .crow > * { min-width:0; }
  .badge { display:flex; align-items:center; gap:5px; font:10.5px/1 var(--mono); color:var(--dim); }
  .badge .star { color:var(--accent); font-size:12px; }
  #send { margin-left:auto; width:26px; height:26px; border-radius:6px; border:0; cursor:pointer;
          background:var(--accent); color:#111; font-size:14px; line-height:1; display:grid; place-items:center; }
  #send:disabled { opacity:.4; cursor:default; }
  #box:focus-within { border-color:#3a4043; }
  #apikey { flex:1; min-width:0; width:100%; border:0; outline:0; background:transparent; color:var(--dim);
            font:11px/1.5 var(--mono); }
  #apikey::placeholder { color:var(--faint); }
  #gateway, #model { background:var(--panel2); color:var(--dim); border:1px solid var(--edge);
            border-radius:6px; padding:4px 6px; font:11px/1.5 var(--mono); min-width:0;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #gateway { flex:0 1 auto; max-width:110px; }
  #model { flex:1 1 auto; min-width:0; max-width:220px; }

  /* content pane (preview / code / database / logs / resources) */
  #pane { flex:1; overflow-y:auto; overflow-x:hidden; position:relative; min-height:0; min-width:0; }
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
  #code { display:grid; grid-template-columns:180px 1fr; height:100%; min-height:0; min-width:0; }
  #tree { border-right:1px solid var(--edge); overflow:auto; padding:8px 0; background:var(--panel); }
  #tree div { padding:5px 12px; cursor:pointer; color:var(--dim); font:12px var(--mono); }
  #tree div[aria-current="true"] { background:var(--panel2); color:var(--fg); }
  #editor { border:0; outline:0; resize:none; width:100%; height:100%; max-width:100%; padding:14px 16px;
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

  /* iOS Safari auto-zooms on focus when the field is <16px. Keep 16px on touch. */
  @media (pointer:coarse), (max-width:768px) {
    #input, #apikey, #editor { font-size:16px; }
  }

  /* Narrow screens (iPhone SE is 375px): one tab fills the screen, hide
     non-essential header stats, enlarge touch targets, respect the notch. */
  @media (max-width:768px) {
    header { padding-top:env(safe-area-inset-top); }
    .metrics { gap:10px; }
    .metrics span:not(#m-built) { display:none; }
    .tab.add { display:none; }
    .tab { padding:10px 12px; }
    #chat, #pane { flex:1; min-height:0; }
    #composer { padding-bottom:calc(8px + env(safe-area-inset-bottom)); }
    #gateway { max-width:84px; }
    #model { max-width:none; }
    #send { width:44px; height:44px; font-size:18px; border-radius:10px; flex:0 0 auto; }
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
  <span class="tab" data-view="chat" role="tab" tabindex="0" aria-selected="true">Chat</span>
  <span class="tab" data-view="preview" role="tab" tabindex="0">Preview</span>
  <span class="tab" data-view="code" role="tab" tabindex="0">Code</span>
  <span class="tab" data-view="database" role="tab" tabindex="0">Database</span>
  <span class="tab" data-view="logs" role="tab" tabindex="0">Logs</span>
  <span class="tab" data-view="resources" role="tab" tabindex="0">Resources</span>
  <span class="tab" data-view="github" role="tab" tabindex="0">GitHub</span>
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
    <div id="chathdr"><span>Chat</span><button id="newchat" title="Clear agent context (code is kept)">New chat</button></div>
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
  <div id="pane" hidden></div>
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

let view = "chat"; // single tab row: chat | preview | code | database | logs | resources | github
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
function addAgent(text, badge) {
  log.appendChild(el("div", "msg agent", text));
  // Restored history passes badge=false: the badge names the picker's
  // current gateway/model, which may differ from what wrote the history.
  if (badge !== false) {
    const m = el("div", "model", "✳ " + gatewaySel.value + "/" + modelSel.value);
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
      addUser(m.content);
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
      const r = await fetch("/api/clear-chat", { method: "POST" });
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

/* ---------- views: one tab visible at a time ---------- */
const chatSection = document.getElementById("chat");
function renderPane() {
  const isChat = view === "chat";
  chatSection.hidden = !isChat;
  pane.hidden = isChat;
  if (isChat) {
    scroll();
    return;
  }
  pane.innerHTML = "";
  if (view === "code") {
    renderCode();
    return;
  }
  if (view === "github") {
    renderGitHub();
    return;
  }
  if (view === "resources") {
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
    pane.scrollTop = 0;
    return;
  }
  if (view === "preview") {
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
    if (r.error) {
      btn.disabled = false; btn.textContent = "Save and build";
      addError("save failed: " + r.error);
      return;
    }
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
let ghStatusFailed = false;

async function ghRefreshStatus() {
  try {
    ghStatus = await fetch("/api/github/status", { cache: "no-store" }).then((r) => r.json());
    ghStatusFailed = false;
  } catch (e) {
    ghStatusFailed = true;
    ghMsg = "could not reach github status: " + (e.message || e);
  }
}

/** Persist the editor's in-memory files before a commit/create, so unsaved
 * browser edits are not silently omitted from the push. */
async function ghSaveAll() {
  const r = await fetch("/api/files", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ files }),
  }).then((r) => r.json());
  if (r.error) throw new Error("save failed: " + r.error);
  files = r.files || files;
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
    const sorted = Object.keys(files).sort();
    activeFile = activeFile in files ? activeFile : sorted[0];
    built = r.built;
    setMetrics(built);
    await ghRefreshStatus();
    ghMsg = "opened " + ref + (r.skipped && r.skipped.length ? " (skipped: " + r.skipped.join(", ") + ")" : "") +
      (r.kept ? " (" + r.kept + " local file(s) kept as uncommitted changes — check status/diff, then commit)" : "") +
      ". Not previewable? Edit files in Code, then commit below.";
  } catch (e) { ghMsg = "open failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghCreate(name, isPrivate, message) {
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  ghBusy = true; ghMsg = "saving files, creating " + name + " and pushing…"; renderPane();
  try {
    await ghSaveAll();
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
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  ghBusy = true; ghMsg = "saving files, committing and pushing…"; renderPane();
  try {
    await ghSaveAll();
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
    "Clones without a runnable capsule still edit and push fine — Preview just shows the build error."));
  if (!ghStatus) {
    // A failed load sets ghStatusFailed and must NOT auto-retry here: this
    // branch runs on every render, so retrying would loop requests forever.
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
    pane.appendChild(wrap);
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
    // Token scopes decide what git can do: a login from before the
    // workflow scope was requested pushes everything except workflow files
    // fine, then 403s the moment one is touched. Show the scopes so a stale
    // token is visible instead of another cryptic push failure.
    const scopes = Array.isArray(ghStatus.scopes) ? ghStatus.scopes : [];
    who.appendChild(el("span", "hint", scopes.length ? "token scopes: " + scopes.join(", ") : "token scopes: unknown"));
    if (scopes.length && !scopes.includes("workflow")) {
      who.appendChild(el("span", "hint", "missing workflow scope — Log out and back in to grant it, or pushes touching .github/workflows/* will 403"));
    }
    // Token kind decides whether git push can ever work: a GitHub-App login
    // (ghu_ token) passes every API check yet 403s each push, so say it up
    // front instead of after another failed push.
    if (ghStatus.tokenKind && ghStatus.tokenKind !== "oauth") {
      who.appendChild(el("span", "hint", "token type: " + ghStatus.tokenKind + " — pushes need an OAuth-App login"));
    }
    const granted = Array.isArray(ghStatus.grantedScopes) ? ghStatus.grantedScopes : [];
    if (granted.length) {
      who.appendChild(el("span", "hint", "granted at login: " + granted.join(", ")));
    }
    if (ghStatus.tokenKind === "github-app") {
      const warn = el("div", "row");
      warn.appendChild(el("span", "hint", "This login used a GitHub App credential: the API works but every git push is refused. Create an OAuth App (Developer settings, OAuth Apps — not GitHub Apps), update the worker secrets, then Log out and back in."));
      wrap.appendChild(warn);
    }
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
    ? \`\${diags.length} type error\${diags.length === 1 ? "" : "s"} — the app preview still runs; lint blocks deploy until these are fixed\`
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
  let settled = false;
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
          // Flush any pending narration first: the model often sends text
          // ("building your redesign now") ahead of its tool calls in the
          // same round, and dropping it makes the transcript look stuck.
          if (agentText) {
            if (thinking.isConnected) thinking.remove();
            addAgent(agentText);
            agentText = "";
          } else if (thinking.isConnected) thinking.remove();
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
    }
    flush();
    // A killed proxy/Worker request closes the stream with no done/error,
    // which previously looked stuck after the last edit. Progress is saved
    // every round, so a retry continues cleanly.
    if (!settled) addError("interrupted before finishing — progress is saved, retry your message");
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
}
function selectTab(elm) {
  // One tab row: the header tab names the only visible view.
  if (!elm.dataset.view) return;
  view = elm.dataset.view;
  syncTabs();
  renderPane();
}
document.querySelectorAll("[data-view]").forEach((n) => {
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
    renderHistory(s.messages);
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