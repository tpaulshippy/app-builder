import { AppSession, type ChatMessage, type FileMap } from "./session";
import { isSafePath } from "./paths";
import { DEFAULT_GATEWAY, DEFAULT_MODEL, GO_MODELS, TOOL_TIMEOUT_MS, ZEN_MODELS, withToolTimeout } from "./agent";
import { APP_SHIM_JS } from "./app-shim";
import { buildAppBundle } from "./lakebed";
import type { AppKind, AppState } from "./app-runtime";
import {
  createRepo,
  deleteRepo,
  exchangeCode,
  getTokenScopes,
  getUser,
  listRepos,
  loginUrl,
  parseRepoRef,
  remoteUrl,
  requireEnv,
  tokenKind,
} from "./github";
import type { GitHubUser } from "./github";
import { MEMBER_COOKIE, turnBusyError } from "./share";
import type { ShareState } from "./share";
import { isWorktreeKey } from "./gitops";
import { inlineLocalAssets, pickPreviewHtml, resolveAssetRef } from "./preview-assets";
import { markdownToHtml } from "./markdown";
import { isImageId, validateImageInput, validateImageRefs } from "./images";

export interface Env {
  APP: DurableObjectNamespace<AppSession>;
  /** Server-side fallback; browsers normally send their own key per request. */
  OPENCODE_ZEN_KEY?: string;
  /** Owned lakebed deploys; anonymous when unset. */
  LAKEBED_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** R2 bucket for chat image attachments (bytes live here, not in DO SQLite). */
  IMAGES?: R2Bucket;
}

export { AppSession };

const SESSION_COOKIE = "ab_session";
const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Anonymous visitors must log in with GitHub before using the app. */
const LOGIN_REQUIRED = { error: "github login required" };

/** Caller identity resolved per request (issue #30: caller-has-access). */
type Access = {
  /** Token to use for GitHub REST/git: the caller's own, never another's. */
  token: string;
  user: GitHubUser | null;
  /** Member id on a shared playground; null on solo sessions. */
  memberId: string | null;
  role: "owner" | "member" | null;
  shared: boolean;
  /** Login to attribute turns/snapshots/pushes to (null when unknown). */
  actor: string | null;
};

type StubLike = {
  getGitHubToken(): Promise<string | null>;
  getShare?: () => Promise<ShareState | null>;
  getMemberToken?: (memberId: string) => Promise<string | null>;
  getMemberUser?: (memberId: string) => Promise<GitHubUser | null>;
};

/**
 * Playground share state, distinguishing "not shared" from "unavailable".
 * A missing method means a legacy stub (solo sessions predate sharing);
 * a throwing method means storage/RPC failure, which must never fail open
 * into owner-token authentication.
 */
async function stubShare(stub: StubLike): Promise<{ ok: true; share: ShareState | null } | { ok: false }> {
  try {
    if (typeof stub.getShare !== "function") return { ok: true, share: null };
    return { ok: true, share: (await stub.getShare()) ?? null };
  } catch {
    return { ok: false };
  }
}

/**
 * Gate every app API behind a GitHub login. Solo sessions keep the old
 * object-has-token posture; shared playgrounds (issue #30) require
 * caller-has-access: the request must carry the caller's own `ab_member`
 * credential, and the token returned is that member's own — the owner's
 * stored token is never handed to another member.
 */
async function requireAccess(
  req: Request,
  stub: StubLike,
  session: { id: string; isNew: boolean },
): Promise<{ access: Access } | { gated: Response }> {
  const lookedUp = await stubShare(stub);
  if (!lookedUp.ok) {
    // Share state unreadable: membership cannot be verified, so reject
    // instead of failing open into owner-token authentication.
    return { gated: sessionJson({ error: "could not verify playground membership — retry" }, session, 500) };
  }
  const share = lookedUp.share;
  if (!share?.enabled) {
    const token = await stub.getGitHubToken();
    if (!token) return { gated: sessionJson(LOGIN_REQUIRED, session, 401) };
    return { access: { token, user: null, memberId: null, role: null, shared: false, actor: null } };
  }
  const secret = readCookie(req, MEMBER_COOKIE);
  const member = secret ? (share.members.find((m) => m.id === secret) ?? null) : null;
  if (!member) {
    return {
      gated: sessionJson({ error: "not a member of this playground — join with an invite code" }, session, 403),
    };
  }
  let token: string | null = null;
  let user: GitHubUser | null = null;
  try {
    token = typeof stub.getMemberToken === "function" ? await stub.getMemberToken(member.id) : null;
    user = typeof stub.getMemberUser === "function" ? await stub.getMemberUser(member.id) : null;
  } catch {
    token = null;
  }
  // Both or neither: a token without user metadata must not silently fall
  // back to the owner's credential on git routes — make them log in again.
  if (!token || !user) return { gated: sessionJson(LOGIN_REQUIRED, session, 401) };
  return {
    access: {
      token,
      user,
      memberId: member.id,
      role: member.role,
      shared: true,
      actor: user.login,
    },
  };
}

/**
 * Legacy gate for routes that predate per-member auth. Shared playgrounds
 * should prefer requireAccess; this stays for the sid-selected app endpoints,
 * which address the owning object directly from the sandbox.
 */
async function requireLogin(
  stub: { getGitHubToken(): Promise<string | null> },
  session: { id: string; isNew: boolean },
): Promise<Response | null> {
  const token = await stub.getGitHubToken();
  if (!token) return sessionJson(LOGIN_REQUIRED, session, 401);
  return null;
}

/**
 * The app view iframe runs sandboxed with an opaque origin, so it cannot use
 * the session cookie (and must never see the parent page). It addresses its
 * Durable Object with an explicit `sid` instead. Same unguessable random id
 * the cookie already carries, same no-auth posture as the rest of this app.
 * A ?sid= URL is not a share link: on shared playgrounds the sid endpoints
 * still require the owning object's token, and joining always mints a fresh
 * member credential (see docs/sharing.md).
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
  boot: { sid: string; preview: string; api: { state: string; mutate: string }; state: unknown; error: unknown },
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
 * behind a proxy and the session must survive that. On shared playgrounds
 * (issue #30) the cookie names the shared object but proves nothing alone —
 * each member also presents their own `ab_member` credential, and joining
 * mints one instead of copying the cookie (docs/sharing.md).
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

/**
 * Set the caller's per-browser playground credential (issue #30). HttpOnly:
 * page scripts never need to read it (it travels on the Cookie header), so
 * script access is denied. Secure follows the request protocol so plain-http
 * local dev keeps working while deployed https gets the flag.
 */
const withMember = (headers: Headers, secret: string | null, req?: Request) => {
  const secure = req && new URL(req.url).protocol === "https:" ? "; Secure" : "";
  if (secret) {
    headers.append("set-cookie", `${MEMBER_COOKIE}=${secret}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
  } else {
    headers.append("set-cookie", `${MEMBER_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`);
  }
  return headers;
};

/** Parse "<playgroundId>.<code>" invite codes (the id routes, the code redeems). */
function parseInviteCode(raw: unknown): { playgroundId: string; code: string } | null {
  if (typeof raw !== "string") return null;
  const dot = raw.lastIndexOf(".");
  if (dot === -1) return null;
  const playgroundId = raw.slice(0, dot);
  const code = raw.slice(dot + 1);
  if (!SID_RE.test(playgroundId) || !/^[A-Za-z0-9]{12}$/.test(code)) return null;
  return { playgroundId, code };
}

type TurnLike = {
  getTurnStatus?: () => Promise<{ active: boolean; actor: string | null }>;
  isTurnActive?: () => Promise<boolean>;
};

/** 409 when a turn runs (naming the actor on shared playgrounds), else null. */
async function turnConflict(
  stub: TurnLike,
  session: { id: string; isNew: boolean },
): Promise<Response | null> {
  try {
    if (typeof stub.getTurnStatus === "function") {
      const turn = await stub.getTurnStatus();
      if (turn?.active) {
        return sessionJson({ error: turnBusyError(turn.actor ?? null) }, session, 409);
      }
    } else if (typeof stub.isTurnActive === "function") {
      // Legacy stubs predate getTurnStatus: same guard, unnamed actor.
      if (await stub.isTurnActive()) {
        return sessionJson({ error: turnBusyError(null) }, session, 409);
      }
    }
  } catch {
    /* status unreadable: let the op run rather than fail the panel */
  }
  return null;
}

type VersionLike = { getFilesVersion?: () => Promise<number>; getFiles?: () => Promise<FileMap> };

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
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      const files = await stub.getFiles();
      const messages = await stub.getMessages();
      const built = await stub.build();
      // version feeds the teammate-edit reload guard; turn/share feed the
      // Sharing panel so the other member sees live state without polling.
      let version = 0;
      let turn = null;
      let share = null;
      try {
        if (typeof stub.getFilesVersion === "function") version = await stub.getFilesVersion();
        if (typeof stub.getTurnStatus === "function") turn = await stub.getTurnStatus();
        const s = stub as { getShareStatus?: (viewerMemberId?: string | null) => Promise<unknown> };
        if (typeof s.getShareStatus === "function") share = await s.getShareStatus(authed.access.memberId);
      } catch {
        /* best-effort extras: files/messages/built above are the state */
      }
      return sessionJson({ files, messages, built, version, turn, share }, session, 200, { "cache-control": "no-store" });
    }

    if (url.pathname === "/api/build" && req.method === "POST") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      return sessionJson({ built: await stub.build() }, session);
    }

    if (url.pathname === "/api/file" && req.method === "POST") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      // Same clobber hazard as the bulk save: read-mutate-write of the whole
      // map races an agent turn's write_file persists.
      const conflict = await turnConflict(stub, session);
      if (conflict) return conflict;
      const { path, content, baseVersion } = (await req.json()) as { path?: string; content?: string; baseVersion?: unknown };
      const key = (path ?? "").trim() || "index.ts";
      if (!isSafePath(key)) {
        return sessionJson({ error: "unsafe path" }, session, 400);
      }
      if (!isWorktreeKey(key)) {
        return sessionJson({ error: "refused path inside .git" }, session, 400);
      }
      // Teammate-edit guard: on shared playgrounds the version is required
      // (an omitted version could silently overwrite a teammate's save), and
      // the compare-and-write runs atomically in the DO — edge
      // check-then-set would still race concurrent saves.
      const saver = stub as {
        saveFileIfVersion?: (
          path: string,
          content: string,
          base: number | undefined,
        ) => Promise<{ ok: boolean; files: FileMap; version: number }>;
        getFilesVersion?: () => Promise<number>;
      };
      if (authed.access.shared && baseVersion === undefined) {
        let version = 0;
        try {
          if (typeof saver.getFilesVersion === "function") version = await saver.getFilesVersion();
        } catch {
          /* best-effort */
        }
        return sessionJson(
          { error: "shared save needs the files version — reload and retry", files: await stub.getFiles(), version },
          session,
          409,
        );
      }
      if (typeof saver.saveFileIfVersion === "function") {
        const saved = await saver.saveFileIfVersion(key, content ?? "", baseVersion as number | undefined);
        if (!saved.ok) {
          return sessionJson(
            { error: "teammate edited — reload: files changed since you loaded them, your copy is stale", files: saved.files, version: saved.version },
            session,
            409,
          );
        }
        return sessionJson({ files: saved.files, built: await stub.build(), version: saved.version }, session);
      }
      const files = { ...(await stub.getFiles()) };
      files[key] = content ?? "";
      await stub.setFiles(files);
      let version = 0;
      try {
        if (typeof saver.getFilesVersion === "function") version = await saver.getFilesVersion();
      } catch {
        /* best-effort */
      }
      return sessionJson({ files, built: await stub.build(), version }, session);
    }

    // Chat image attachments: bytes live in R2 (via the session object), the
    // transcript keeps only `{ id, mimeType }` refs, and the model receives
    // inline base64 through Pi's UserInput on the next turn.
    if (url.pathname === "/api/images" && req.method === "POST") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return sessionJson({ error: "expected a JSON body" }, session, 400);
      }
      const { data, mimeType } = (body ?? {}) as { data?: unknown; mimeType?: unknown };
      try {
        if (typeof data !== "string") throw new Error("image data is required");
        if (typeof mimeType !== "string") throw new Error("image mimeType is required");
        const saved = await stub.saveImage(data, mimeType);
        return sessionJson(
          { id: saved.id, url: `/api/images/${saved.id}`, mimeType: saved.mimeType, size: saved.size },
          session,
        );
      } catch (e) {
        return sessionJson({ error: e instanceof Error ? e.message : String(e) }, session, 400);
      }
    }

    const imageMatch = url.pathname.match(/^\/api\/images\/([A-Za-z0-9-]+)$/);
    if (imageMatch && req.method === "DELETE") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      const id = imageMatch[1] as string;
      try {
        await stub.deleteImage(id);
        return sessionJson({ ok: true }, session);
      } catch (e) {
        return sessionJson({ error: e instanceof Error ? e.message : String(e) }, session, 400);
      }
    }
    if (imageMatch && req.method === "GET") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      const id = imageMatch[1] as string;
      if (!isImageId(id)) return sessionJson({ error: "bad image id" }, session, 400);
      const stored = await stub.getImage(id);
      if (!stored) return sessionJson({ error: "image not found" }, session, 404);
      let bytes: Uint8Array;
      try {
        const checked = validateImageInput(stored.data, stored.mimeType);
        bytes = Uint8Array.from(atob(checked.data), (c) => c.charCodeAt(0));
      } catch {
        return sessionJson({ error: "image unreadable" }, session, 500);
      }
      // `bytes.buffer` may be a SharedArrayBuffer over a pool: slice to the
      // exact view before responding.
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return new Response(body, {
        headers: withSession(
          new Headers({
            "content-type": stored.mimeType,
            "cache-control": "private, max-age=3153600",
          }),
          session,
        ),
      });
    }

    if (url.pathname === "/api/reset" && req.method === "POST") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      return sessionJson(await stub.reset(), session);
    }

    // Clear agent context only; capsule files are left untouched. The chat
    // transcript persists per session in the Durable Object, so without this
    // a refresh restores an invisible history that still consumes context.
    if (url.pathname === "/api/clear-chat" && req.method === "POST") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      await stub.clearChat();
      return sessionJson({ ok: true }, session);
    }

    // Named chat checkpoints: snapshot the current messages + files, list
    // them newest-first, or restore one into the live session.
    if (url.pathname === "/api/chats" && req.method === "GET") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      // Current link rides along so the picker can show it without a second
      // round-trip; best-effort for stub shapes that lack getGitHubStatus.
      let linked: unknown = null;
      try {
        linked = (await stub.getGitHubStatus())?.linked ?? null;
      } catch {
        linked = null;
      }
      return sessionJson({ chats: await stub.listChats(), linked }, session, 200, { "cache-control": "no-store" });
    }

    if (url.pathname === "/api/chats/snapshot" && req.method === "POST") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      let title = "";
      let files: FileMap | undefined;
      try {
        const body = (await req.json()) as { title?: unknown; files?: unknown };
        title = body.title as string ?? "";
        // The Code tab keeps unsaved edits in browser memory: the snapshot
        // button sends its file map so the checkpoint captures them. Validate
        // like the bulk-save endpoint; omitted means "persisted state" (Pi
        // turns, auto-checkpoints, older clients).
        if (body.files !== undefined) {
          if (!body.files || typeof body.files !== "object" || Array.isArray(body.files)) {
            return sessionJson({ error: "expected { files }" }, session, 400);
          }
          for (const key of Object.keys(body.files as FileMap)) {
            if (!isWorktreeKey(key) || typeof (body.files as FileMap)[key] !== "string") {
              return sessionJson({ error: `refused path: ${key}` }, session, 400);
            }
          }
          files = { ...(body.files as FileMap) };
        }
      } catch {
        /* empty body: default title */
      }
      try {
        return sessionJson({ chat: await stub.snapshotChat(typeof title === "string" ? title : "", files, authed.access.actor ?? undefined) }, session);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status = message.startsWith("chat snapshot too large") ? 413
          : message.startsWith("an agent turn is in progress") ? 409
          : 500;
        return sessionJson({ error: message }, session, status);
      }
    }

    const renameMatch = url.pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]{8,64})\/?rename$/);
    if (renameMatch && req.method === "POST") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      let title = "";
      try {
        title = ((await req.json()) as { title?: unknown }).title as string ?? "";
      } catch {
        /* empty body: title required below */
      }
      if (typeof title !== "string" || !title.trim()) {
        return sessionJson({ error: "snapshot title is required" }, session, 400);
      }
      try {
        return sessionJson({ chat: await stub.renameChat(renameMatch[1] as string, title) }, session);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status =
          message === "chat snapshot not found" ? 404
          : message.startsWith("chat snapshot too large") ? 413
          : 500;
        return sessionJson({ error: message }, session, status);
      }
    }

    const resumeMatch = url.pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]{8,64})\/?resume$/);
    if (resumeMatch && req.method === "POST") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      try {
        // resumeChat builds under its own lock, so the response always
        // describes the session it restored.
        return sessionJson(await stub.resumeChat(resumeMatch[1] as string, authed.access.actor ?? undefined), session);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status = message === "chat snapshot not found" ? 404 : message.startsWith("chat snapshot too large") ? 413 : 500;
        return sessionJson({ error: message }, session, status);
      }
    }

    const deleteMatch = url.pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]{8,64})\/delete\/?$/);
    if (deleteMatch && req.method === "POST") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      try {
        return sessionJson(await stub.deleteChat(deleteMatch[1] as string), session);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status = message === "chat snapshot not found" ? 404 : 500;
        return sessionJson({ error: message }, session, status);
      }
    }

    // Start a fresh chat session, optionally bound to a repo: an optional
    // title snapshots the current chat first, an optional repoRef clones the
    // repo, then the agent context clears so the new session starts clean.
    if (url.pathname === "/api/chats/start" && req.method === "POST") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      // Same clobber hazard as the bulk file save: cloning replaces the whole
      // FileMap, so refuse while an agent turn is writing instead of racing
      // it and losing either side's files.
      const conflict = await turnConflict(stub, session);
      if (conflict) return conflict;
      const as = authed.access.shared && authed.access.user
        ? { token: authed.access.token, user: authed.access.user }
        : undefined;
      let body: { repoRef?: unknown; branch?: unknown; title?: unknown } = {};
      try {
        const parsed = (await req.json()) as typeof body;
        if (parsed && typeof parsed === "object") body = parsed;
      } catch {
        /* empty body: fresh chat with no repo */
      }
      const repoRef = typeof body.repoRef === "string" ? body.repoRef.trim() : "";
      const branch = typeof body.branch === "string" ? body.branch.trim() : "";
      const title = typeof body.title === "string" ? body.title : "";
      try {
        if (title.trim()) await stub.snapshotChat(title, undefined, authed.access.actor ?? undefined);
        let cloned: { files?: unknown; meta?: unknown } | null = null;
        if (repoRef) {
          const { owner, repo } = parseRepoRef(repoRef);
          cloned = await stub.cloneFromGitHub({ owner, repo, branch: branch || undefined, ...(as ? { as } : {}) });
        } else {
          // No repo picked: drop a stale link so the fresh chat, its header
          // badge, and its snapshots do not inherit the previous repo.
          await stub.unlinkRepo();
        }
        await stub.clearChat();
        const built = await stub.build();
        let linked: unknown = cloned?.meta ?? null;
        try {
          linked = (await stub.getGitHubStatus())?.linked ?? linked;
        } catch {
          /* stub without status: keep the clone meta */
        }
        return sessionJson({ files: await stub.getFiles(), built, linked }, session);
      } catch (e) {
        const message = (e as Error).message;
        const status = message.startsWith("chat snapshot too large") ? 413 : 500;
        return sessionJson({ error: message }, session, status);
      }
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

    // Live app view endpoints. The iframe runs sandboxed to an opaque origin
    // with no cookies, so it cannot present `ab_member`. It presents a
    // short-lived preview capability minted by the cookie-authenticated
    // parent instead (POST /api/share/preview): a bare `?sid=` — which the
    // invite URL discloses — never suffices on its own.
    if (url.pathname === "/api/app-state" || url.pathname === "/api/app-mutate") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: APP_CORS });
    }

    /**
     * Preview capability check for the sandboxed iframe. Stubs that predate
     * preview tokens (tests, older shapes) fall back to the object-token
     * gate; real objects always enforce the capability.
     */
    const checkPreview = async (
      sidStub: {
        getGitHubToken?: () => Promise<string | null>;
        checkPreviewToken?: (preview: unknown) => Promise<{ memberId: string | null } | null>;
      },
      preview: unknown,
    ): Promise<Response | null> => {
      if (typeof sidStub.checkPreviewToken === "function") {
        const grant = await sidStub.checkPreviewToken(preview).catch(() => null);
        if (!grant) {
          return corsJson(
            { ok: false, error: { name: "Auth", message: "preview expired or invalid — reload the preview" } },
            401,
          );
        }
        return null;
      }
      return null;
    };

    if (url.pathname === "/api/app-state") {
      const sid = url.searchParams.get("sid") ?? "";
      if (!SID_RE.test(sid)) return corsJson({ ok: false, error: { name: "Session", message: "bad sid" } }, 400);
      // Same login boundary as the cookie APIs, but on the sid-selected
      // object: the iframe carries no cookie and its sid is guessable only
      // by its owner, yet anonymous reads/mutations must still 401.
      const sidStub = env.APP.get(env.APP.idFromName(sid));
      if (!(await sidStub.getGitHubToken())) {
        return corsJson({ ok: false, error: { name: "Auth", message: "github login required" } }, 401);
      }
      const previewGate = await checkPreview(sidStub, url.searchParams.get("preview"));
      if (previewGate) return previewGate;
      return corsJson(await sidStub.appState());
    }

    if (url.pathname === "/api/app-mutate" && req.method === "POST") {
      let body: { sid?: unknown; preview?: unknown; kind?: unknown; name?: unknown; args?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return corsJson({ ok: false, error: { name: "Request", message: "expected a JSON body" } }, 400);
      }
      if (typeof body.sid !== "string" || !SID_RE.test(body.sid)) {
        return corsJson({ ok: false, error: { name: "Session", message: "bad sid" } }, 400);
      }
      const mutateStub = env.APP.get(env.APP.idFromName(body.sid));
      if (!(await mutateStub.getGitHubToken())) {
        return corsJson({ ok: false, error: { name: "Auth", message: "github login required" } }, 401);
      }
      const mutateGate = await checkPreview(mutateStub, body.preview);
      if (mutateGate) return mutateGate;
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
        await mutateStub.appMutate(kind, body.name, body.args ?? []),
      );
    }

    if (url.pathname === "/api/app") {
      const sid = url.searchParams.get("sid") ?? "";
      if (!SID_RE.test(sid)) return new Response("bad sid", { status: 400 });
      const appStub = env.APP.get(env.APP.idFromName(sid));
      if (!(await appStub.getGitHubToken())) {
        return new Response("github login required", { status: 401 });
      }
      // The served document embeds live state: gate the capability like the
      // JSON endpoints, or the sid alone (disclosed by invite URLs) loads it.
      if (typeof appStub.checkPreviewToken === "function") {
        const grant = await appStub.checkPreviewToken(url.searchParams.get("preview")).catch(() => null);
        if (!grant) return new Response("preview expired or invalid — reload the preview", { status: 401 });
      }
      const previewParam = url.searchParams.get("preview") ?? "";
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
          preview: previewParam,
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
    // Gated like every other session API: it answers for the caller's object.
    if (url.pathname === "/api/pi-harness-status" && req.method === "GET") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
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
      // GitHub login comes before the API-key check: anonymous visitors get
      // the login gate, not the key prompt.
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      const actor = authed.access.actor;
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return sessionJson({ error: "expected a JSON body" }, session, 400);
      }
      if (!body || typeof body !== "object") {
        return sessionJson({ error: "expected a JSON body" }, session, 400);
      }
      const { message, key, gateway, model, images } = body as {
        message?: unknown;
        key?: string;
        gateway?: string;
        model?: string;
        images?: unknown;
      };
      if (typeof message !== "string" || !message.trim()) {
        return sessionJson({ error: "empty message" }, session, 400);
      }
      let imageRefs: { id: string }[];
      try {
        imageRefs = validateImageRefs(images);
      } catch (e) {
        return sessionJson({ error: e instanceof Error ? e.message : String(e) }, session, 400);
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
            body: JSON.stringify({ message, apiKey, gateway, model, images: imageRefs, author: actor, memberId: authed.access.memberId }),
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
      // Shared playgrounds scope status to the calling member (their own
      // login/token), so one member never sees another's token state as
      // their own. No member credential: legacy solo status.
      try {
        const lookedUp = await stubShare(stub);
        const share = lookedUp.ok ? lookedUp.share : null;
        if (share?.enabled) {
          const secret = readCookie(req, MEMBER_COOKIE);
          const member = secret ? (share.members.find((m) => m.id === secret) ?? null) : null;
          if (member) {
            const memberToken = typeof stub.getMemberToken === "function"
              ? await stub.getMemberToken(member.id).catch(() => null)
              : null;
            const memberUser = typeof stub.getMemberUser === "function"
              ? await stub.getMemberUser(member.id).catch(() => null)
              : null;
            const linked = (await stub.getGitHubStatus().catch(() => null))?.linked ?? null;
            const scopes = memberToken ? await getTokenScopes(memberToken).catch(() => []) : [];
            let shareStatus: unknown = null;
            try {
              const s = stub as { getShareStatus?: (viewerMemberId?: string | null) => Promise<unknown> };
              if (typeof s.getShareStatus === "function") shareStatus = await s.getShareStatus(member.id);
            } catch {
              shareStatus = null;
            }
            return sessionJson(
              {
                connected: !!memberToken,
                user: memberUser ?? (member.login ? { login: member.login, id: member.userId ?? 0 } : null),
                linked,
                scopes,
                grantedScopes: [],
                tokenKind: tokenKind(memberToken),
                ...(shareStatus ? { share: shareStatus } : {}),
              },
              session,
              200,
              { "cache-control": "no-store" },
            );
          }
        }
      } catch {
        /* fall through to the solo status */
      }
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
        // Shared playgrounds store the token under the calling member, never
        // the owner slot: joining + logging in must not grant the owner's
        // stored credential, and must not overwrite it either.
        let memberId: string | null = null;
        let sharedLookupFailed = false;
        try {
          const t = target as unknown as {
            getShare?: () => Promise<ShareState | null>;
            setMemberToken?: (id: string, token: string, user: GitHubUser) => Promise<void>;
          };
          if (typeof t.getShare === "function") {
            const share = await t.getShare();
            if (share?.enabled) {
              const secret = readCookie(req, MEMBER_COOKIE);
              const member = secret ? (share.members.find((m) => m.id === secret) ?? null) : null;
              if (!member) {
                return new Response("this playground is shared — join with an invite code first", { status: 403 });
              }
              if (typeof t.setMemberToken === "function") memberId = member.id;
            }
          }
        } catch {
          // Share state unreadable: storing the token now could credit the
          // wrong slot, so fail instead of guessing.
          sharedLookupFailed = true;
        }
        if (sharedLookupFailed) {
          return new Response("could not verify playground membership — retry login", { status: 500 });
        }
        if (memberId) {
          const t = target as unknown as {
            setMemberToken: (id: string, token: string, user: GitHubUser) => Promise<void>;
          };
          await t.setMemberToken(memberId, token, user);
        } else {
          await target.setGitHubToken(token, user, grantedScopes);
        }
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
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      // On a shared playground, logging out drops only the caller's own
      // token (membership stays, so re-login restores). clearGitHub would
      // wipe the link/history for everyone — never run it on a shared DO.
      if (authed.access.shared && authed.access.memberId && typeof stub.clearMemberToken === "function") {
        await stub.clearMemberToken(authed.access.memberId);
      } else {
        await stub.clearGitHub();
      }
      return sessionJson({ ok: true }, session);
    }

    // ---------- Live sharing (issue #30) ----------

    // Owner creates (or rotates) the join invite. Joining mints a fresh
    // member credential — the owner's cookie and token are never shared.
    if (url.pathname === "/api/share/invite" && req.method === "POST") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      if (authed.access.shared && authed.access.role !== "owner") {
        return sessionJson({ error: "only the playground owner can invite" }, session, 403);
      }
      try {
        const invite = await stub.createInvite();
        // The owner needs their member credential from here on: shared mode
        // requires it on every request, and without this cookie the invite
        // would lock the owner out of their own playground.
        const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
        withMember(headers, (invite as { memberSecret?: string }).memberSecret ?? null, req);
        return new Response(JSON.stringify({ ...invite, playgroundId: session.id }), { headers });
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    // Redeem "<playgroundId>.<code>": the caller's cookie is mapped onto the
    // shared DO and a per-browser member secret is set. No login needed yet —
    // the member links their own GitHub account afterwards.
    if (url.pathname === "/api/share/join" && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return sessionJson({ error: "expected a JSON body" }, session, 400);
      }
      const parsed = parseInviteCode((body as { code?: unknown })?.code);
      if (!parsed) {
        return sessionJson({ error: 'expected { code } as "<playgroundId>.<code>"' }, session, 400);
      }
      const target = env.APP.get(env.APP.idFromName(parsed.playgroundId));
      try {
        const { memberSecret } = await target.joinPlayground(parsed.code);
        const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
        headers.append(
          "set-cookie",
          `${SESSION_COOKIE}=${parsed.playgroundId}; Path=/; Max-Age=31536000; SameSite=Lax`,
        );
        withMember(headers, memberSecret, req);
        return new Response(JSON.stringify({ ok: true }), { headers });
      } catch (e) {
        return sessionJson({ error: e instanceof Error ? e.message : String(e) }, session, 400);
      }
    }

    // Sharing panel state. Members see members/turn/audit; non-members only
    // learn that the playground is shared (join state), never the roster.
    if (url.pathname === "/api/share/status") {
      try {
        const lookedUp = await stubShare(stub);
        if (!lookedUp.ok) {
          return sessionJson({ error: "could not verify playground membership — retry" }, session, 500);
        }
        const share = lookedUp.share;
        if (!share?.enabled) {
          let turn = null;
          let filesVersion = 0;
          try {
            const s = stub as {
              getTurnStatus?: () => Promise<unknown>;
              getFilesVersion?: () => Promise<number>;
            };
            if (typeof s.getTurnStatus === "function") turn = await s.getTurnStatus();
            if (typeof s.getFilesVersion === "function") filesVersion = await s.getFilesVersion();
          } catch {
            /* best-effort */
          }
          return sessionJson({ shared: false, joined: true, turn, filesVersion }, session, 200, {
            "cache-control": "no-store",
          });
        }
        const secret = readCookie(req, MEMBER_COOKIE);
        const member = secret ? (share.members.find((m) => m.id === secret) ?? null) : null;
        if (!member) {
          return sessionJson({ shared: true, joined: false }, session, 200, { "cache-control": "no-store" });
        }
        const s = stub as { getShareStatus?: (viewerMemberId?: string | null) => Promise<unknown> };
        const status =
          typeof s.getShareStatus === "function" ? await s.getShareStatus(member.id) : { shared: true };
        return sessionJson({ ...(status as Record<string, unknown>), joined: true }, session, 200, {
          "cache-control": "no-store",
        });
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    // Short-lived iframe capability (see preview tokens in session): minted
    // by the cookie-authenticated, member-gated parent before mounting the
    // sandboxed frame, which cannot present cookies or `ab_member` itself.
    if (url.pathname === "/api/share/preview" && req.method === "POST") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      try {
        if (typeof stub.mintPreviewToken !== "function") {
          return sessionJson({ error: "preview tokens unavailable" }, session, 500);
        }
        return sessionJson(await stub.mintPreviewToken(authed.access.memberId), session);
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    // Leave a shared playground: membership and the member's token go, the
    // playground persists for the rest. Fresh solo session afterwards.
    if (url.pathname === "/api/share/leave" && req.method === "POST") {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      if (!authed.access.shared || !authed.access.memberId) {
        return sessionJson({ error: "this playground is not shared" }, session, 400);
      }
      try {
        if (typeof stub.leavePlayground === "function") {
          await stub.leavePlayground(authed.access.memberId);
        }
        const fresh = crypto.randomUUID();
        const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
        headers.append("set-cookie", `${SESSION_COOKIE}=${fresh}; Path=/; Max-Age=31536000; SameSite=Lax`);
        withMember(headers, null, req);
        return new Response(JSON.stringify({ ok: true }), { headers });
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    if (url.pathname === "/api/github/repos") {
      try {
        const authed = await requireAccess(req, stub, session);
        if ("gated" in authed) return authed.gated;
        return sessionJson({ repos: await listRepos(authed.access.token) }, session, 200, {
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
        const authed = await requireAccess(req, stub, session);
        if ("gated" in authed) return authed.gated;
        // The browser snapshot can lag an active agent turn; replacing the
        // whole FileMap then would discard already-persisted agent edits.
        const conflict = await turnConflict(stub, session);
        if (conflict) return conflict;
        const { files: incoming, baseVersion } = (await req.json()) as { files?: FileMap; baseVersion?: unknown };
        if (!incoming || typeof incoming !== "object") {
          return sessionJson({ error: "expected { files }" }, session, 400);
        }
        for (const key of Object.keys(incoming)) {
          if (!isWorktreeKey(key) || typeof incoming[key] !== "string") {
            return sessionJson({ error: `refused path: ${key}` }, session, 400);
          }
        }
        const saver = stub as {
          saveFilesIfVersion?: (
            files: FileMap,
            base: number | undefined,
          ) => Promise<{ ok: boolean; files?: FileMap; version: number }>;
          getFilesVersion?: () => Promise<number>;
          getFiles?: () => Promise<FileMap>;
        };
        // Same required-version + atomic-compare rule as /api/file: on
        // shared playgrounds an omitted version could silently overwrite a
        // teammate's save, and edge check-then-set still races.
        if (authed.access.shared && baseVersion === undefined) {
          let version = 0;
          let files: FileMap = {};
          try {
            if (typeof saver.getFilesVersion === "function") version = await saver.getFilesVersion();
            if (typeof saver.getFiles === "function") files = await saver.getFiles();
          } catch {
            /* best-effort */
          }
          return sessionJson(
            { error: "shared save needs the files version — reload and retry", files, version },
            session,
            409,
          );
        }
        if (typeof saver.saveFilesIfVersion === "function") {
          const saved = await saver.saveFilesIfVersion({ ...incoming }, baseVersion as number | undefined);
          if (!saved.ok) {
            return sessionJson(
              { error: "teammate edited — reload: files changed since you loaded them, your copy is stale", files: saved.files, version: saved.version },
              session,
              409,
            );
          }
          let files: FileMap = { ...incoming };
          try {
            if (typeof saver.getFiles === "function") files = await saver.getFiles();
          } catch {
            /* best-effort */
          }
          return sessionJson({ files, version: saved.version }, session);
        }
        await stub.setFiles({ ...incoming });
        let version = 0;
        try {
          if (typeof saver.getFilesVersion === "function") version = await saver.getFilesVersion();
        } catch {
          /* best-effort */
        }
        return sessionJson({ files: await stub.getFiles(), version }, session);
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    if (url.pathname === "/api/github/create" && req.method === "POST") {
      try {
        const authed = await requireAccess(req, stub, session);
        if ("gated" in authed) return authed.gated;
        // The acting member's own token (never another member's): on a shared
        // playground a member without write access gets the collaborator
        // error from assertPushAccess, not an owner-token push.
        const token = authed.access.token;
        const as = authed.access.shared && authed.access.user
          ? { token, user: authed.access.user }
          : undefined;
        const { name, private: isPrivate, description, message } = (await req.json()) as {
          name?: string;
          private?: boolean;
          description?: string;
          message?: string;
        };
        if (!name || !name.trim()) return sessionJson({ error: "repo name is required" }, session, 400);
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
            ...(as ? { as } : {}),
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
        const authed = await requireAccess(req, stub, session);
        if ("gated" in authed) return authed.gated;
        const as = authed.access.shared && authed.access.user
          ? { token: authed.access.token, user: authed.access.user }
          : undefined;
        const { ref, branch } = (await req.json()) as { ref?: string; branch?: string };
        if (!ref || !ref.trim()) return sessionJson({ error: "owner/repo is required" }, session, 400);
        const { owner, repo } = parseRepoRef(ref);
        const cloned = await stub.cloneFromGitHub({ owner, repo, branch: branch?.trim() || undefined, ...(as ? { as } : {}) });
        const built = await stub.build();
        return sessionJson({ ...cloned, built }, session);
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    if (url.pathname === "/api/git/commit" && req.method === "POST") {
      try {
        const authed = await requireAccess(req, stub, session);
        if ("gated" in authed) return authed.gated;
        const as = authed.access.shared && authed.access.user
          ? { token: authed.access.token, user: authed.access.user }
          : undefined;
        const { message } = (await req.json()) as { message?: string };
        if (!message || !message.trim()) return sessionJson({ error: "commit message is required" }, session, 400);
        const r = await stub.commitPush(message.trim(), ...(as ? [as] : []));
        return sessionJson({ ...r, status: await stub.gitStatus() }, session);
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    if (url.pathname === "/api/git/pull" && req.method === "POST") {
      try {
        const authed = await requireAccess(req, stub, session);
        if ("gated" in authed) return authed.gated;
        const as = authed.access.shared && authed.access.user
          ? { token: authed.access.token, user: authed.access.user }
          : undefined;
        const r = await stub.pullFromRemote(...(as ? [as] : []));
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
        const authed = await requireAccess(req, stub, session);
        if ("gated" in authed) return authed.gated;
        // Behind the serialized git queue server-side: bound it so a
        // stalled push/pull/fetch fails this read visibly instead of
        // hanging the panel indefinitely.
        const status = await withToolTimeout(stub.gitStatus(), TOOL_TIMEOUT_MS, "git status");
        return sessionJson({ status }, session, 200, {
          "cache-control": "no-store",
        });
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    if (url.pathname === "/api/git/log") {
      try {
        const authed = await requireAccess(req, stub, session);
        if ("gated" in authed) return authed.gated;
        const log = await withToolTimeout(stub.gitLog(), TOOL_TIMEOUT_MS, "git log");
        return sessionJson({ log }, session, 200, {
          "cache-control": "no-store",
        });
      } catch (e) {
        return sessionJson({ error: (e as Error).message }, session, 500);
      }
    }

    if (url.pathname === "/api/git/run" && req.method === "POST") {
      try {
        const authed = await requireAccess(req, stub, session);
        if ("gated" in authed) return authed.gated;
        const as = authed.access.shared && authed.access.user
          ? { token: authed.access.token, user: authed.access.user }
          : undefined;
        const { command } = (await req.json()) as { command?: string };
        if (!command || !command.trim()) return sessionJson({ error: "command is required" }, session, 400);
        // Same bound as the Pi tool path and the panel reads: a stalled
        // push/pull/fetch must fail visibly, not spin ghBusy forever. The
        // server-side op may still complete; push/pull/fetch retries are safe.
        const r = await withToolTimeout(stub.gitRun(command.trim(), ...(as ? [as] : [])), TOOL_TIMEOUT_MS, "git command");
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
        // Timeout (or RPC/storage failure) with a possibly still-running
        // server op: return current server files so the panel resyncs
        // instead of later overwriting the op's working-tree changes with
        // its stale copy. Best-effort — a completion landing after this
        // read can still race; the version guard in gitRun protects the
        // op's own write, not a later bulk save.
        let files: FileMap | undefined;
        try {
          files = await stub.getFiles();
        } catch {
          /* storage failure: report the error without files */
        }
        return sessionJson({ error: (e as Error).message, ...(files ? { files } : {}) }, session, 500);
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
  #chathdr { display:flex; align-items:center; gap:8px; padding:8px 14px 0; flex:0 0 auto; min-width:0;
             overflow:hidden; white-space:nowrap;
             font:10px/1 var(--mono); text-transform:uppercase; letter-spacing:1px; color:var(--faint); }
  #chathdr > span:first-child { flex:0 0 auto; }
  #newchat { margin-left:auto; background:transparent; color:var(--dim); border:1px solid var(--edge);
             border-radius:6px; padding:4px 9px; font:10.5px/1.4 var(--mono); cursor:pointer;
             flex:0 0 auto; white-space:nowrap; }
  #newchat:hover { color:var(--fg); border-color:#3a4043; }
  #newchat:disabled { opacity:.4; cursor:default; }
  #history { padding:16px 20px; max-width:880px; width:100%; margin:0 auto; overflow-y:auto; }
  #history .hrow { display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap; }
  #history .hhead { font:10px/1 var(--mono); text-transform:uppercase; letter-spacing:1px;
           color:var(--faint); margin:2px 0 8px; }
  #history input { flex:1; background:var(--panel); border:1px solid var(--edge); border-radius:6px;
           color:var(--fg); padding:5px 8px; font:11.5px var(--sans); }
  #history button { background:var(--panel2); color:var(--fg); border:1px solid var(--edge);
           border-radius:6px; padding:5px 10px; font-size:11.5px; cursor:pointer; }
  #history button.primary { background:var(--accent); color:#111; border:0; font-weight:600; }
  #history button:disabled { opacity:.45; cursor:default; }
  #history .item .repo { display:inline-block; font:10px/1.6 var(--mono); color:var(--accent);
           border:1px solid var(--edge); border-radius:5px; padding:1px 7px; margin-top:4px; }
  #history select { background:var(--panel); border:1px solid var(--edge); border-radius:6px;
           color:var(--fg); padding:5px 8px; font-size:11.5px; max-width:100%; }
  #repobadge { flex:0 0 auto; background:transparent; cursor:pointer; font:13px/1 var(--mono);
           color:var(--accent); border:1px solid var(--edge); border-radius:5px; padding:3px 7px; }
  #repobadge:hover { color:var(--fg); border-color:#3a4043; }
  #repobadge.none { color:var(--faint); }
  #history .item { border:1px solid var(--edge); border-radius:7px; padding:7px 9px; margin-bottom:6px;
           background:var(--panel); }
  #history .item .t { font-size:12.5px; font-weight:600; cursor:pointer; }
  #history .item .t:hover { text-decoration:underline; }
  #history .item .t:focus-visible { outline:1px solid var(--accent); outline-offset:2px; }
  #history button.icon { padding:5px 9px; font-size:14px; line-height:1; }
  #history .item .m { font:10.5px/1.5 var(--mono); color:var(--faint); margin-top:2px; }
  #history .item .p { font-size:12px; color:var(--dim); margin-top:3px;
           white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #log { flex:1; overflow-y:auto; padding:14px 14px 8px; min-width:0; }
  .who { font:10px/1 var(--mono); text-transform:uppercase; letter-spacing:1px; color:var(--faint); margin:2px 0 8px; }
  .msg { margin:0 0 14px; white-space:pre-wrap; overflow-wrap:anywhere; min-width:0; }
  .msg.user { color:var(--fg); }
  .msg.agent { color:#c9ced1; white-space:normal; }
  .msg.agent p { margin:0 0 8px; }
  .msg.agent p:last-child { margin-bottom:0; }
  .msg.agent h1, .msg.agent h2, .msg.agent h3, .msg.agent h4 { margin:10px 0 6px; line-height:1.3; }
  .msg.agent h1:first-child, .msg.agent h2:first-child, .msg.agent h3:first-child, .msg.agent p:first-child { margin-top:0; }
  .msg.agent h1 { font-size:15px; } .msg.agent h2 { font-size:14px; }
  .msg.agent h3, .msg.agent h4 { font-size:13px; }
  .msg.agent ul, .msg.agent ol { margin:4px 0 8px 18px; padding:0; }
  .msg.agent li { margin:2px 0; }
  .msg.agent code { font-family:var(--mono); font-size:12px; background:var(--panel2);
    border:1px solid var(--edge); border-radius:5px; padding:1px 5px; overflow-wrap:anywhere; }
  .msg.agent pre { background:var(--panel); border:1px solid var(--edge); border-radius:7px;
    padding:9px 11px; overflow:auto; margin:6px 0 10px; }
  .msg.agent pre code { background:transparent; border:0; padding:0; white-space:pre; display:block; }
  .msg.agent blockquote { border-left:2px solid var(--edge); margin:4px 0 8px; padding:2px 0 2px 10px; color:var(--dim); }
  .msg.agent a { color:var(--accent); }
  .msg.agent hr { border:0; border-top:1px solid var(--edge); margin:10px 0; }
  .msg.agent strong { color:var(--fg); }
  .tool { display:flex; gap:7px; align-items:flex-start; color:var(--dim); font-size:12.5px; margin:3px 0; min-width:0; }
  .tool .mark { color:var(--ok); font-family:var(--mono); flex:0 0 auto; }
  .tool > span:last-child { flex:1 1 auto; min-width:0; overflow-wrap:anywhere; white-space:pre-wrap; }
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
  .crow { display:flex; align-items:center; gap:4px; margin-top:2px; min-width:0; flex-wrap:nowrap; }
  .crow > * { min-width:0; }
  .badge { display:flex; align-items:center; gap:5px; font:10.5px/1 var(--mono); color:var(--dim); }
  .badge .star { color:var(--accent); font-size:12px; }
  #send { margin-left:auto; width:32px; height:32px; border-radius:50%; border:0; cursor:pointer;
          background:var(--accent); color:#111; font-size:16px; line-height:1; display:grid; place-items:center;
          flex:0 0 auto; }
  #send:disabled { opacity:.4; cursor:default; }
  #box:focus-within { border-color:#3a4043; }
  #gh #apikey { background:var(--panel); border:1px solid var(--edge); border-radius:6px;
           color:var(--fg); padding:6px 9px; font:12.5px var(--sans); min-width:220px; flex:1; }
  #gh #apikey::placeholder { color:var(--faint); }
  #gh #gateway { background:var(--panel); color:var(--fg); border:1px solid var(--edge);
            border-radius:6px; padding:6px 9px; font:12.5px var(--sans); min-width:0; max-width:160px; }
  #model { flex:1 1 auto; min-width:0; max-width:none; background:transparent; color:var(--dim);
            border:0; outline:0; padding:6px 2px; font:13px/1.5 var(--sans); cursor:pointer;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #attach { background:transparent; color:var(--fg); border:0; border-radius:8px; width:32px; height:32px;
            font-size:22px; line-height:1; cursor:pointer; flex:0 0 auto; display:grid; place-items:center; }
  #attach:hover { color:var(--accent); }
  #attach:disabled { opacity:.4; cursor:default; }
  #pending { display:flex; gap:8px; flex-wrap:wrap; margin-top:6px; }
  #pending[hidden] { display:none; }
  #pending .thumb { position:relative; width:64px; height:64px; border:1px solid var(--edge);
            border-radius:8px; overflow:hidden; background:var(--panel2); flex:0 0 auto; }
  #pending .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
  #pending .thumb button { position:absolute; top:2px; right:2px; width:18px; height:18px; border-radius:50%;
            border:0; background:rgba(0,0,0,.65); color:#fff; font-size:11px; line-height:1; cursor:pointer; }
  #pending .thumb .thumbwait { width:100%; height:100%; display:grid; place-items:center;
            color:var(--faint); font-size:18px; }
  #pending .thumb.uploading { opacity:.5; }
  .msg .imgs { display:flex; gap:8px; flex-wrap:wrap; margin-top:6px; }
  .msg .imgs img { max-width:min(100%, 320px); max-height:220px; border:1px solid var(--edge);
            border-radius:8px; display:block; object-fit:contain; background:var(--panel); }

  /* content pane (preview / code / database / logs) */
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
  #savebar { position:absolute; right:18px; bottom:16px; display:flex; gap:8px; align-items:center; }
  #snapname { background:var(--panel); border:1px solid var(--edge); border-radius:6px;
           color:var(--fg); padding:6px 9px; font:12px var(--sans); width:170px; }
  #snapbtn { background:var(--panel2); color:var(--fg); border:1px solid var(--edge);
           border-radius:6px; padding:6px 12px; font-size:12px; cursor:pointer; white-space:nowrap; }
  #snapbtn:disabled { opacity:.45; cursor:default; }
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

  /* login gate: anonymous visitors see this instead of the app */
  #gate { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
         gap:10px; text-align:center; padding:40px 24px; min-height:0; }
  #gate[hidden] { display:none; }
  #gate h1 { font-size:24px; margin:0 0 2px; letter-spacing:-.3px; }
  #gate p { color:var(--dim); margin:0 0 8px; max-width:440px; }
  #gate button.primary { background:var(--accent); color:#111; border:0; border-radius:8px;
         padding:10px 18px; font-weight:600; font-size:14px; cursor:pointer; }
  #gate .hint { font-size:12px; color:var(--faint); }

  /* iOS Safari auto-zooms on focus when the field is <16px. Keep 16px on touch. */
  @media (pointer:coarse), (max-width:768px) {
    body { font-size:16px; }
    input, textarea, select, button { font-size:16px; }
    #input, #apikey, #editor, #snapname { font-size:16px; }
    #history input, #history button, #history button.icon, #history select,
    #gateway, #gh #gateway, #model, #gh input, #gh input[type=text], #gh input[type=password], #gh button, #gh #apikey,
    #snapbtn, #save, #send, #attach, #newchat, #repobadge,
    #gate button.primary { font-size:16px; }
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
    #send { width:40px; height:40px; font-size:18px; flex:0 0 auto; }
    #attach { width:40px; height:40px; }
    #preview { padding:16px; }
    .banner { margin:0 16px 12px; }
    #code { grid-template-columns:1fr; grid-template-rows:auto 1fr; }
    #tree { display:flex; overflow-x:auto; border-right:0; border-bottom:1px solid var(--edge); padding:4px 6px; }
    #tree div { white-space:nowrap; padding:10px 12px; }
    #savebar { right:12px; bottom:12px; }
    #save { padding:12px 18px; }
  }
</style>
</head>
<body>
<header>
  <span class="tab" data-view="chat" role="tab" tabindex="0" aria-selected="true">Chat</span>
  <span class="tab" data-view="history" role="tab" tabindex="0">History</span>
  <span class="tab" data-view="preview" role="tab" tabindex="0">Preview</span>
  <span class="tab" data-view="code" role="tab" tabindex="0">Code</span>
  <span class="tab" data-view="database" role="tab" tabindex="0" style="display:none">Database</span>
  <span class="tab" data-view="logs" role="tab" tabindex="0">Logs</span>
  <span class="tab" data-view="github" role="tab" tabindex="0">Settings</span>
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
    <div id="chathdr"><span>Chat</span><button id="repobadge" class="none" title="No repo linked — tap to open Settings" aria-label="Linked repo — open Settings">⎇</button><button id="newchat" title="Clear agent context (code is kept)">New chat</button></div>
    <div id="log"></div>
    <div id="composer">
      <div id="box">
        <textarea id="input" placeholder="What do you want to build? (paste images to attach — Enter for newline, ⌘/Ctrl+Enter to send)" rows="2" enterkeyhint="enter"></textarea>
        <div id="pending" hidden></div>
        <div class="crow">
          <button id="attach" title="Attach images (png/jpeg/webp/gif, max 4)" aria-label="Attach images">+</button>
          <input id="filepick" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden />
          <select id="model" title="Model"></select>
          <button id="send" title="Send (⌘/Ctrl+Enter)" aria-label="Send">↑</button>
        </div>
      </div>
    </div>
  </section>
  <div id="pane" hidden></div>
  <section id="gate" hidden>
    <h1>app-builder</h1>
    <p>Log in with GitHub to use Chat, Code, Preview, Database and Logs.</p>
    <button id="loginbtn" class="primary">Log in with GitHub</button>
    <p class="hint">OAuth; token stays server-side.</p>
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
  // Chrome on iOS injects GCrWeb helpers (__gCrWeb.*) into every page; when
  // they throw, window.onerror attributes them to our inline script. Not
  // ours, not actionable.
  if (msg.includes("__gCrWeb")) return;
  const n = document.createElement("div");
  n.className = "err";
  n.textContent = "js error: " + msg;
  log.appendChild(n);
});
const pane = document.getElementById("pane");
// Static-html Preview helpers (pure, unit-tested in tests/preview-assets.test.ts;
// serialized here so the page and the tests run the same code).
${pickPreviewHtml}
${resolveAssetRef}
${inlineLocalAssets}
// Assistant markdown (pure, unit-tested in tests/markdown.test.ts; serialized
// here so the page and the tests run the same code).
// The worker TS transform wraps nested helpers with __name(), which has no
// browser definition — the identity shim below is what that helper does.
var __name = (fn) => fn;
${markdownToHtml}
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
// The API key field lives in the Settings tab (renderGitHub): localStorage is
// the source of truth, the input just edits it when that tab is rendered.
const readApiKey = () => {
  const field = document.getElementById("apikey");
  const v = (field && field.value) || localStorage.getItem("ab_key") || "";
  return v.trim();
};
const modelSel = document.getElementById("model");
// Gateway (zen vs go) lives in Settings; localStorage is the source of truth
// so the composer works even when that tab was never rendered.
function getGateway() {
  const g = localStorage.getItem("ab_gateway") || DEFAULT_GATEWAY;
  return GATEWAYS[g] ? g : DEFAULT_GATEWAY;
}
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
function setGateway(gw) {
  if (!GATEWAYS[gw]) gw = DEFAULT_GATEWAY;
  localStorage.setItem("ab_gateway", gw);
  fillModels(gw, modelSel.value);
  localStorage.setItem("ab_model", modelSel.value);
  const sel = document.getElementById("gateway");
  if (sel && sel.value !== gw) sel.value = gw;
}
fillModels(getGateway(), localStorage.getItem("ab_model") || DEFAULT_MODEL);
modelSel.onchange = () => localStorage.setItem("ab_model", modelSel.value);
const mBundle = document.getElementById("m-bundle");
const mBuilt = document.getElementById("m-built");

let view = "chat"; // single tab row: chat | history | preview | code | database | logs | github
let files = { "server/index.ts": "" };
let activeFile = "server/index.ts";
// Selected html file for Preview when the repo has no capsule.
let activePreview = null;
let built = null;
let busy = false;
// True from first paint until the boot status/state round-trip settles: the
// transcript shows a loading row meanwhile, and send stays off.
let booting = true;
// Anonymous until the boot status check (or any 401) says otherwise: the
// gate replaces every app view and hides its tabs, GitHub tab excepted.
let authed = false;
const gate = document.getElementById("gate");
const loginBtn = document.getElementById("loginbtn");
if (loginBtn) loginBtn.onclick = () => { window.location.href = "/api/github/login"; };
// The mounted preview iframe, if any: it reports login loss it sees first.
let appFrameEl = null;
// The sandboxed preview cannot reach apiFetch, so its shim posts an expiry
// message instead (source-checked: opaque-origin frames report "null").
window.addEventListener("message", (e) => {
  if (!e.data || e.data !== "app-builder:auth-required") return;
  if (!appFrameEl || e.source !== appFrameEl.contentWindow) return;
  if (authed) showGate();
});

/** Hide the app tabs until the visitor logs in; the GitHub tab stays. */
function syncGateTabs() {
  document.querySelectorAll("[data-view]").forEach((t) => {
    if (t.dataset.view === "github") return;
    t.style.display = authed ? "" : "none";
  });
  syncCapsuleTabs();
}

/** A repo counts as a capsule when it has both entries the capsule runtime needs. */
function hasCapsuleFiles() {
  return "server/index.ts" in files && "client/index.tsx" in files;
}

/**
 * The Database and Logs tabs only apply to capsule repos: without a server entry
 * there is no isolate state or console output to show, so the tabs stay hidden
 * and the pane falls back to Preview. Runs on every render, since opening
 * another repo can gain or lose the capsule entries at any time.
 */
function syncCapsuleTabs() {
  document.querySelectorAll('[data-view="database"], [data-view="logs"]').forEach((t) => {
    t.style.display = authed && hasCapsuleFiles() ? "" : "none";
  });
  if ((view === "database" || view === "logs") && !hasCapsuleFiles()) {
    view = "preview";
    syncTabs();
  }
}

/** Drop to the login gate, unmounting the preview frame so its shim stops polling. */
function showGate() {
  authed = false;
  syncGateTabs();
  appFrameEl = null;
  pane.innerHTML = "";
  // Drop the cached login state: the GitHub view renders from this cache,
  // and stale connected state would show authenticated controls after logout.
  ghStatus = null;
  ghMsg = "";
  ghRepos = [];
  updateRepoBadge(null);
  renderPane();
}

/**
 * A login-required 401 anywhere drops the app back to the gate. Both 401
 * shapes are recognized: the cookie APIs error string and the sid
 * endpoints ok-false error object.
 */
function noteLoginRequired(body) {
  const lost = !!body && (body.error === "github login required" ||
    (body.ok === false && body.error && body.error.message === "github login required"));
  if (lost && authed) showGate();
  return lost;
}

/** Authenticated API fetch: same as fetch, but a lost login shows the gate. */
async function apiFetch(url, init) {
  const r = await fetch(url, init);
  if (r.status === 401) {
    try { noteLoginRequired(await r.clone().json()); } catch { /* non-JSON 401: not ours */ }
  }
  return r;
}
// Bumped on every successful build so the app iframe reloads against fresh
// files. The iframe is otherwise left alone (remounts wipe its UI state).
let appV = 0;

const sessionId = () => {
  const m = document.cookie.match(/(?:^|; *)ab_session=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "";
};

/**
 * Preview capability for the cookieless iframe (see /api/share/preview):
 * minted per mount by the authenticated parent. The token rides the frame
 * URL (which already carries the sid); page scripts never need to read it.
 */
async function previewToken() {
  const r = await apiFetch("/api/share/preview", { method: "POST" }).then((r) => r.json());
  if (r.error) throw new Error(r.error);
  if (!r.preview) throw new Error("preview token missing");
  return r.preview;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ---------- chat transcript ---------- */
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

/* ---------- session history: named checkpoints of chat + files ---------- */
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
  // a free-form owner/repo input, then POST /api/chats/start.
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
      if (ghStatus) ghStatus.linked = r.linked || null;
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
  prow.appendChild(pick); prow.appendChild(refIn); prow.appendChild(brIn);
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
    if (ghStatus) ghStatus.linked = r.linked || null;
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
    item.appendChild(el("div", "m", when + " · " + c.messageCount + " messages"));
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
        if (ghStatus) ghStatus.linked = r.linked || null;
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

/* ---------- views: one tab visible at a time ---------- */
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

/* ---------- live sharing (issue #30): two members, one playground ---------- */
let shStatus = null;
let shMsg = "";
let shBusy = false;
let shLoaded = false;
/** Whole-FileMap version from /api/state; saves send it back as baseVersion. */
let filesVersion = 0;

async function shRefresh() {
  try {
    shStatus = await apiFetch("/api/share/status", { cache: "no-store" }).then((r) => r.json());
    shLoaded = true;
  } catch (e) {
    shMsg = "could not reach sharing status: " + (e.message || e);
  }
}

async function shInvite() {
  if (shBusy) return;
  shBusy = true; shMsg = "creating invite…"; renderPane();
  try {
    const r = await apiFetch("/api/share/invite", { method: "POST" }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    const link = location.origin + "/?invite=" + encodeURIComponent(r.playgroundId + "." + r.code);
    try {
      await navigator.clipboard.writeText(link);
      shMsg = "invite link copied (expires in 24h). They join as themselves — your login and token are never shared.";
    } catch {
      shMsg = "invite link (expires in 24h): " + link;
    }
    await shRefresh();
  } catch (e) { shMsg = "invite failed: " + (e.message || e); }
  shBusy = false; renderPane();
}

async function shJoin(code) {
  code = (code || "").trim();
  if (!code) { shMsg = "paste an invite code first"; renderPane(); return; }
  if (shBusy) return;
  shBusy = true; shMsg = "joining…"; renderPane();
  try {
    const r = await apiFetch("/api/share/join", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    // Cookies now name the shared playground: reload into it.
    location.href = "/";
  } catch (e) { shMsg = "join failed: " + (e.message || e); }
  shBusy = false; renderPane();
}

async function shLeave() {
  if (shBusy) return;
  shBusy = true; shMsg = "leaving…"; renderPane();
  try {
    const r = await apiFetch("/api/share/leave", { method: "POST" }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    location.href = "/";
  } catch (e) { shMsg = "leave failed: " + (e.message || e); }
  shBusy = false; renderPane();
}

/** Sharing section of the GitHub tab: invite/join, roster, turn, audit. */
function renderSharing(wrap) {
  wrap.appendChild(el("h2", null, "Sharing"));
  if (!shLoaded) {
    if (!shStatus) {
      wrap.appendChild(el("p", "hint", "loading sharing…"));
      shRefresh().then(renderPane);
    }
    if (shMsg) wrap.appendChild(el("pre", "out", shMsg));
    return;
  }
  if (!shStatus.shared) {
    wrap.appendChild(el("p", "hint",
      "This playground is private to you. To work together live, invite one teammate by link: " +
      "they join as themselves with their own GitHub login — your cookie and your token are never shared. " +
      "Pushes are attributed to whoever pushes; a member without write access gets the collaborator error, not your token."));
    const row = el("div", "row");
    const b = el("button", "primary", shBusy ? "…" : "Invite teammate");
    b.disabled = shBusy || !(ghStatus && ghStatus.connected);
    b.title = ghStatus && ghStatus.connected ? "Create a 24h invite link" : "Log in with GitHub first";
    b.onclick = shInvite;
    row.appendChild(b);
    wrap.appendChild(row);
  } else {
    const members = Array.isArray(shStatus.members) ? shStatus.members : [];
    const names = members.map((m) => (m.login || "pending invite") + " (" + m.role + ")").join(", ") || "—";
    wrap.appendChild(el("p", "hint", "Shared playground — live files, chat, and preview for: " + names));
    const turn = shStatus.turn || {};
    wrap.appendChild(el("p", "hint", turn.active
      ? "Agent turn running" + (turn.actor ? " (" + turn.actor + ")" : "") + (turn.queued ? " — " + turn.queued + " queued" : " — new turns queue behind it")
      : "Agent idle — either member can drive the next turn."));
    wrap.appendChild(el("p", "hint", "Files version " + (shStatus.filesVersion ?? "?") + " — if your save says a teammate edited first, reload: their files are adopted, nothing is silently overwritten."));
    const audit = Array.isArray(shStatus.audit) ? shStatus.audit.slice(0, 8) : [];
    if (audit.length) {
      wrap.appendChild(el("p", "hint", "Recent: " + audit.map((a) =>
        a.actor + " " + a.action + (a.detail ? " " + a.detail : "")).join(" · ").slice(0, 400)));
    }
    // Only the owner may invite (the endpoint 403s otherwise, and status
    // only carries the code for the owner): members get leave, not rotate.
    const isOwner = !!(shStatus.owner && shStatus.owner.login && ghStatus && ghStatus.user &&
      shStatus.owner.login === ghStatus.user.login);
    const row = el("div", "row");
    if (isOwner) {
      const copy = el("button", null, shBusy ? "…" : "Copy invite link");
      copy.disabled = shBusy;
      copy.onclick = shInvite;
      copy.title = "Create a fresh 24h invite link (rotates the previous one)";
      row.appendChild(copy);
    } else if (shStatus.invite) {
      wrap.appendChild(el("p", "hint", "Invite rotation is owner-only — ask " + shStatus.owner.login + " for a fresh link."));
    }
    const leave = el("button", null, "Leave playground");
    leave.disabled = shBusy;
    leave.onclick = shLeave;
    row.appendChild(leave);
    wrap.appendChild(row);
  }
  const jrow = el("div", "row");
  const code = document.createElement("input");
  code.type = "text";
  code.placeholder = "paste invite code to join";
  code.setAttribute("aria-label", "Invite code");
  const join = el("button", null, "Join playground");
  join.disabled = shBusy;
  join.onclick = () => shJoin(code.value);
  jrow.appendChild(code);
  jrow.appendChild(join);
  wrap.appendChild(jrow);
  if (shMsg) wrap.appendChild(el("pre", "out", shMsg));
}

/** Persist the editor's in-memory files before a commit/create, so unsaved
 * browser edits are not silently omitted from the push. Sends the version the
 * editor rendered from: a teammate persisting first 409s, and we adopt the
 * server files (reload prompt) instead of silently overwriting them. */
async function ghSaveAll() {
  const r = await apiFetch("/api/files", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ files, baseVersion: filesVersion }),
  }).then((r) => r.json());
  if (r.error && r.files) {
    files = r.files;
    if (typeof r.version === "number") filesVersion = r.version;
    renderPane();
  }
  if (r.error) throw new Error("save failed: " + r.error);
  files = r.files || files;
  if (typeof r.version === "number") filesVersion = r.version;
}

async function ghLoadRepos() {
  ghBusy = true; renderPane();
  try {
    const r = await apiFetch("/api/github/repos").then((r) => r.json());
    if (r.error) ghMsg = r.error;
    else { ghRepos = r.repos || []; ghMsg = ghRepos.length ? "" : "no repos found"; }
  } catch (e) { ghMsg = "repo list failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

function ghNote(t) { ghMsg = t; renderPane(); }

async function ghOpen(ref, branch) {
  ghBusy = true; ghMsg = "cloning " + ref + "…"; renderPane();
  try {
    const r = await apiFetch("/api/github/open", {
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
    updateRepoBadge(ghStatus && ghStatus.linked);
    ghMsg = "opened " + ref + (r.skipped && r.skipped.length ? " (skipped: " + r.skipped.join(", ") + ")" : "") +
      (r.kept ? " (" + r.kept + " local file(s) kept as uncommitted changes — check status/diff, then commit)" : "") +
      ". Nothing to preview? Edit files in Code, then commit below.";
  } catch (e) { ghMsg = "open failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghCreate(name, isPrivate, message) {
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  ghBusy = true; ghMsg = "saving files, creating " + name + " and pushing…"; renderPane();
  try {
    await ghSaveAll();
    const r = await apiFetch("/api/github/create", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, private: isPrivate, message }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    await ghRefreshStatus();
    updateRepoBadge(ghStatus && ghStatus.linked);
    ghMsg = "created " + r.repo.fullName + " and pushed. " + (r.output || "").slice(0, 300);
  } catch (e) { ghMsg = "create failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghCommitPush(message) {
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  ghBusy = true; ghMsg = "saving files, committing and pushing…"; renderPane();
  try {
    await ghSaveAll();
    const r = await apiFetch("/api/git/commit", {
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
    const r = await apiFetch("/api/git/pull", { method: "POST" }).then((r) => r.json());
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
    const r = await apiFetch("/api/git/" + which, { cache: "no-store" }).then((r) => r.json());
    ghMsg = (which === "status" ? (r.status || r.error) : (r.log || r.error)) || "(empty)";
  } catch (e) { ghMsg = which + " failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghRunCmd(cmd) {
  ghBusy = true; ghMsg = "running git " + cmd + "…"; renderPane();
  try {
    const r = await apiFetch("/api/git/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: cmd }),
    }).then((r) => r.json());
    // Adopt server files even on error: a timed-out op may still complete
    // server-side, and the next Commit/Create must not overwrite its
    // working-tree changes with this panel's stale copy.
    if (r.files) files = r.files;
    if (r.error) throw new Error(r.error);
    if (r.built) { built = r.built; setMetrics(built); }
    ghMsg = "$ git " + cmd + "\\n" + ((r.stdout || "") + "\\n" + (r.stderr || "")).trim().slice(0, 2000) || "(no output)";
  } catch (e) { ghMsg = "git run failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

function renderGitHub() {
  const wrap = el("div");
  wrap.id = "gh";
  wrap.appendChild(el("h2", null, "Settings"));
  wrap.appendChild(el("p", "hint", "Model API key, stored only in this browser."));
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
  wrap.appendChild(el("h2", null, "Model"));
  wrap.appendChild(el("p", "hint", "Gateway for chat (zen vs go). Model is picked in the composer below the prompt."));
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
  wrap.appendChild(el("h2", null, "GitHub"));
  wrap.appendChild(el("p", "hint",
    "Log in, then create a repo from the current files or open one to edit here. " +
    "Clones without a runnable capsule still edit and push fine — Preview shows an html file when the repo has one, otherwise the build error."));
  // Sharing renders above the status-gated controls: the invite/join warning
  // must stay available while GitHub status is loading or failing, not just
  // when it succeeds.
  renderSharing(wrap);
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
      await apiFetch("/api/github/logout", { method: "POST" });
      ghStatus = null; ghRepos = [];
      await ghRefreshStatus();
      if (ghStatus && ghStatus.connected) {
        authed = true; syncGateTabs(); renderPane();
      } else {
        showGate();
      }
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

/* ---------- image attachments (paste / attach, stored in R2) ---------- */
const attachBtn = document.getElementById("attach");
const filePick = document.getElementById("filepick");
const pendingBox = document.getElementById("pending");
const box = document.getElementById("box");
let pendingImages = [];
let uploading = 0;
function renderPending() {
  if (!pendingBox) return;
  pendingBox.innerHTML = "";
  pendingBox.hidden = !pendingImages.length;
  for (const p of pendingImages) {
    const t = el("div", "thumb" + (p.uploading ? " uploading" : ""));
    if (p.preview) {
      const img = document.createElement("img");
      img.src = p.preview;
      img.alt = "attached image";
      t.appendChild(img);
    } else {
      t.appendChild(el("div", "thumbwait", "…"));
    }
    const x = el("button", null, "×");
    x.title = "Remove attachment";
    x.setAttribute("aria-label", "Remove attachment");
    x.onclick = () => {
      pendingImages = pendingImages.filter((q) => q !== p);
      // The bytes were already persisted on attach: delete the R2 object so
      // removed attachments do not linger as orphans. Best-effort — a
      // failure keeps the (harmless, unreferenced) bytes, never the UI.
      if (p.id) {
        apiFetch("/api/images/" + encodeURIComponent(p.id), { method: "DELETE" }).catch(() => {});
      }
      renderPending();
      syncSend();
    };
    t.appendChild(x);
    pendingBox.appendChild(t);
  }
}
function syncSend() {
  sendBtn.disabled = busy || uploading > 0 || booting;
}
/** Read a File as a data URL (for upload + instant thumbnail). */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("could not read " + (file.name || "image")));
    r.readAsDataURL(file);
  });
}
/** Upload data URLs: at most 4 total, images only, 5 MiB each (server enforces). */
async function attachFiles(files) {
  const list = [...(files || [])].filter((f) => f && /^image\\//.test(f.type || ""));
  if (!list.length) return;
  const valid = [];
  for (const file of list) {
    if (file.size > 5 * 1024 * 1024) {
      addError("image too large (max 5 MiB): " + (file.name || "pasted image"));
      continue;
    }
    valid.push(file);
  }
  if (!valid.length) return;
  // Reserve slots synchronously: concurrent paste/drop/pick events must not
  // all pass the cap check before any of them records its entries.
  const slots = 4 - pendingImages.length;
  if (slots <= 0) {
    addError("at most 4 images per message");
    return;
  }
  const take = valid.slice(0, slots);
  if (valid.length > slots) addError("at most 4 images per message (extras ignored)");
  uploading += take.length;
  syncSend();
  const entries = take.map((file) => {
    const entry = { preview: "", uploading: true, id: null, mimeType: file.type || "image/png", file };
    pendingImages.push(entry);
    return entry;
  });
  renderPending();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const preview = await readAsDataUrl(entry.file);
        entry.preview = preview;
        renderPending();
        const r = await apiFetch("/api/images", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: preview, mimeType: entry.mimeType }),
        }).then((r) => r.json());
        if (r.error) throw new Error(r.error);
        entry.id = r.id;
        entry.mimeType = r.mimeType || entry.mimeType;
        entry.uploading = false;
      } catch (e) {
        pendingImages = pendingImages.filter((q) => q !== entry);
        addError("upload failed: " + (e.message ?? e));
      } finally {
        uploading--;
      }
    }),
  );
  renderPending();
  syncSend();
}
if (attachBtn && filePick) {
  attachBtn.onclick = () => filePick.click();
  filePick.onchange = () => {
    attachFiles(filePick.files).catch((e) => addError(e.message ?? String(e)));
    filePick.value = "";
  };
}
if (box) {
  box.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault();
  });
  box.addEventListener("drop", (e) => {
    // Claim the drop before filtering: a non-image file must not trigger the
    // browser default (which navigates away from the app).
    if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /^image\\//.test(f.type || ""));
    if (files.length) {
      attachFiles(files).catch((err) => addError(err.message ?? String(err)));
    }
  });
}
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\\//.test(f.type || ""));
  const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith("image/"));
  if (files.length || items.length) {
    const picked = files.length ? files : items.map((i) => i.getAsFile()).filter(Boolean);
    if (picked.length) {
      e.preventDefault();
      attachFiles(picked).catch((err) => addError(err.message ?? String(err)));
    }
  }
});

/* ---------- agent stream ---------- */
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

function syncTabs() {
  document.querySelectorAll("[data-view]").forEach((o) => {
    if (o.dataset.view === view) o.setAttribute("aria-selected", "true");
    else o.removeAttribute("aria-selected");
  });
}
function selectTab(elm) {
  // One tab row: the header tab names the only visible view.
  if (!elm.dataset.view) return;
  // The gate hides app tabs for anonymous visitors; ignore clicks that slip
  // through (keyboard focus) so the gate cannot be bypassed client-side.
  if (!authed && elm.dataset.view !== "github") return;
  // The Database tab is hidden without a capsule; ignore focus-driven
  // selection the same way so a hidden tab never becomes the live view.
  if (elm.dataset.view === "database" && !hasCapsuleFiles()) return;
  view = elm.dataset.view;
  syncTabs();
  renderPane();
}
document.querySelectorAll("[data-view]").forEach((n) => {
  n.onclick = () => selectTab(n);
  n.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectTab(n); } };
});

(async () => {
  const loading = el("div", "msg thinking", "Loading session…");
  log.appendChild(loading);
  mBuilt.textContent = "loading…";
  sendBtn.disabled = true;
  try {
    // Invite links land here as /?invite=<playground>.<code>: redeem first
    // so the cookies name the shared playground before anything else loads.
    const inviteParam = new URLSearchParams(location.search).get("invite");
    if (inviteParam) {
      history.replaceState(null, "", "/");
      try {
        const j = await fetch("/api/share/join", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: inviteParam }),
        }).then((r) => r.json());
        if (j.error) throw new Error(j.error);
        location.reload();
        return;
      } catch (e) {
        loading.remove();
        mBuilt.textContent = "invite error";
        mBuilt.className = "failed";
        log.appendChild(el("div", "err", "invite failed: " + (e.message ?? e)));
        return;
      }
    }
    // Gated behind GitHub login: learn the login state first, and only load
    // files/chat history for connected sessions. Anonymous visitors land on
    // the gate; the 302 to / after OAuth re-runs this connected.
    const g = await fetch("/api/github/status", { cache: "no-store" }).then((r) => r.json());
    ghStatus = g;
    authed = !!(g && g.connected);
    syncGateTabs();
    updateRepoBadge(g && g.linked);
    if (!authed) { loading.remove(); mBuilt.textContent = "idle"; renderPane(); return; }
    // no-store: /api/state runs a build, so any cached copy is already wrong.
    const s = await apiFetch("/api/state", { cache: "no-store" }).then((r) => r.json());
    if (s.error) {
      // Logged out between the status check and here (logout in another tab):
      // fall back to the gate instead of a stuck error.
      if (s.error === "github login required") { loading.remove(); mBuilt.textContent = "idle"; showGate(); return; }
      throw new Error(s.error);
    }
    files = s.files || files;
    built = s.built;
    if (typeof s.version === "number") filesVersion = s.version;
    setMetrics(built);
    renderHistory(s.messages);
    renderPane();
  } catch (e) {
    loading.remove();
    mBuilt.textContent = "state error";
    mBuilt.className = "failed";
    log.appendChild(el("div", "err", "could not load state: " + (e.message ?? e)));
  } finally {
    booting = false;
    sendBtn.disabled = false;
  }
})();
</script>
</body>
</html>`;