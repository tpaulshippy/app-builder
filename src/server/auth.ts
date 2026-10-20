import { canonicalIdForGithubUser, isCanonicalId, parseSessionValue } from "../session-key";
import type { GitHubUser } from "../github";
import { MEMBER_COOKIE, turnBusyError } from "../share";
import type { ShareState } from "../share";
import type { AppSession, FileMap } from "../session";
import type { Env } from "../index";

export const SESSION_COOKIE = "ab_session";
// One-time OAuth login nonce (issue #35 review): bound to the browser that
// started the login so a bare playground id in `state` cannot be replayed
// cross-browser (login CSRF). See the login/callback routes.
export const LOGIN_STATE_COOKIE = "ab_login_state";
// Canonical bearers (`gh-<userId>.<secret>`); the bare canonical id alone
// never authenticates (see parseSessionValue), and the lookahead keeps it
// out of the legacy branch too so over-long numeric ids can't slip through.
export const SID_RE = /^(?:(?!gh-\d+$)[A-Za-z0-9_-]{8,64}|gh-\d{1,20}\.[A-Za-z0-9_-]{8,64})$/;

/** Anonymous visitors must log in with GitHub before using the app. */
export const LOGIN_REQUIRED = { error: "github login required" };

/** Caller identity resolved per request (issue #30: caller-has-access). */
export type Access = {
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

export type StubLike = {
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
export async function stubShare(stub: StubLike): Promise<{ ok: true; share: ShareState | null } | { ok: false }> {
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
export async function requireAccess(
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
export async function requireLogin(
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
 * Durable Object with an explicit `sid` instead: the full session bearer,
 * verified against the allowlist exactly like the cookie (see resolveSid).
 * A ?sid= URL is not a share link: on shared playgrounds the sid endpoints
 * still require the owning object's token, and joining always mints a fresh
 * member credential (see docs/sharing.md).
 */
export const APP_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept",
};

export const corsJson = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...APP_CORS, ...extra }),
  });

export function readCookie(req: Request, name: string): string | null {
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
 * behind a proxy and the session must survive that. After GitHub login the
 * value is a canonical bearer (`gh-<userId>.<secret>`) shared by all of that
 * user's browsers (see resolveAuth); before login it is a random per-browser
 * id that lazily migrates on first authenticated use. On shared playgrounds
 * (issue #30) the cookie names the shared object but proves nothing alone —
 * each member also presents their own `ab_member` credential, and joining
 * mints one instead of copying the cookie (docs/sharing.md).
 */
export function resolveSession(req: Request): { id: string; isNew: boolean } {
  const fromCookie = readCookie(req, SESSION_COOKIE);
  // A bare canonical id (`gh-<userId>`) is routable but never authenticating
  // (see parseSessionValue): it is the join cookie for a shared playground,
  // whose members prove themselves with `ab_member` instead (requireAccess).
  if (fromCookie && (parseSessionValue(fromCookie) || isCanonicalId(fromCookie))) {
    return { id: fromCookie, isNew: false };
  }
  return { id: crypto.randomUUID(), isNew: true };
}

export const withSession = (headers: Headers, session: { id: string; isNew: boolean }) => {
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
export const withMember = (headers: Headers, secret: string | null, req?: Request) => {
  const secure = req && new URL(req.url).protocol === "https:" ? "; Secure" : "";
  if (secret) {
    headers.append("set-cookie", `${MEMBER_COOKIE}=${secret}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
  } else {
    headers.append("set-cookie", `${MEMBER_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`);
  }
  return headers;
};

/** Parse "<playgroundId>.<code>" invite codes (the id routes, the code redeems). */
export function parseInviteCode(raw: unknown): { playgroundId: string; code: string } | null {
  if (typeof raw !== "string") return null;
  const dot = raw.lastIndexOf(".");
  if (dot === -1) return null;
  const playgroundId = raw.slice(0, dot);
  const code = raw.slice(dot + 1);
  // The playground id is routable, never authenticating: a legacy device id
  // or a bare canonical id (`gh-<userId>`, the shared object's name — the
  // secret stays server-side and is never part of the invite). Membership is
  // proven separately by the member credential (see requireAccess).
  if ((!SID_RE.test(playgroundId) && !isCanonicalId(playgroundId)) || !/^[A-Za-z0-9]{12}$/.test(code)) return null;
  return { playgroundId, code };
}

type TurnLike = {
  getTurnStatus?: () => Promise<{ active: boolean; actor: string | null }>;
  isTurnActive?: () => Promise<boolean>;
};

/** 409 when a turn runs (naming the actor on shared playgrounds), else null. */
export async function turnConflict(
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
export type AuthStub = {
  getGitHubToken(): Promise<string | null>;
  getGitHubStatus(): Promise<{ connected: boolean; user: { login: string; id: number } | null; grantedScopes?: string[] }>;
};

/**
 * Resolve the request's cookie to the owning Durable Object.
 *
 * Canonical bearers (`gh-<userId>.<secret>`) address the shared per-user
 * object after the secret allowlist check — one workspace across all of that
 * user's browsers, which is what resumes a session on a new device. Legacy
 * random cookies from before the switch lazily migrate on first use: the
 * device object's state is copied to the fresh canonical object once, a
 * secret is minted, and the response reissues the cookie as a bearer.
 *
 * Shared playgrounds (issue #30) are exempt from that migration: the cookie
 * names the shared object and members prove themselves with their own
 * `ab_member` credential (requireAccess), so adopting the playground into
 * one member's canonical object would fork it away from everyone else. A
 * bare canonical id likewise routes only to a share-enabled object — the id
 * alone is public and never authenticates a solo session.
 *
 * Stubs without the new methods (tests, older isolates) fall back to the
 * legacy direct mapping.
 */
export async function resolveAuth(
  env: Env,
  session: { id: string; isNew: boolean },
): Promise<{ stub: AuthStub & Record<string, any>; session: { id: string; isNew: boolean } }> {
  const parsed = parseSessionValue(session.id);
  const direct = (name: string) => env.APP.get(env.APP.idFromName(name)) as unknown as AuthStub & Record<string, any>;
  /** The named object iff it is an enabled shared playground, else null. */
  const sharedTarget = async (name: string): Promise<(AuthStub & Record<string, any>) | null> => {
    const stub = direct(name);
    try {
      const maybeShared = stub as unknown as { getShare?: () => Promise<{ enabled?: boolean } | null> };
      if (typeof maybeShared.getShare === "function") {
        const share = await maybeShared.getShare();
        if (share?.enabled) return stub;
      }
    } catch {
      /* share check failed: not a proven playground — no direct routing */
    }
    return null;
  };
  if (!parsed) {
    // Bare canonical ids join members to a shared playground; anything else
    // unparseable is anonymous. Solo sessions never route by bare id.
    if (isCanonicalId(session.id)) {
      const target = await sharedTarget(session.id);
      if (target) return { stub: target, session };
    }
    const fresh = crypto.randomUUID();
    return { stub: direct(fresh), session: { id: fresh, isNew: true } };
  }
  if (parsed.kind === "canonical") {
    const stub = direct(parsed.canonicalId);
    try {
      if (typeof stub.checkSessionSecret === "function") {
        if (await stub.checkSessionSecret(parsed.secret)) return { stub, session };
      } else {
        // Mock/legacy stub shape: preserve the old direct behavior.
        return { stub, session };
      }
    } catch {
      /* storage failure: fall through to anonymous */
    }
    const fresh = crypto.randomUUID();
    return { stub: direct(fresh), session: { id: fresh, isNew: true } };
  }
  const device = direct(parsed.deviceId);
  try {
    // A shared playground is owned collectively: skip the canonical adoption
    // below so the playground is never copied into one member's object.
    if (await sharedTarget(parsed.deviceId)) return { stub: device, session };
    if (typeof device.getGitHubStatus !== "function") return { stub: device, session };
    const status = await device.getGitHubStatus();
    const userId = status?.connected ? status?.user?.id : undefined;
    if (!userId) return { stub: device, session };
    const canonicalId = canonicalIdForGithubUser(userId);
    const canonical = direct(canonicalId);
    const secret = crypto.randomUUID();
    const hasClaim =
      typeof canonical.claimGithubSession === "function" && typeof canonical.addSessionSecret === "function";
    if (!hasClaim) return { stub: device, session };
    const existing = await canonical.getGitHubToken().catch(() => null);
    if (!existing) {
      const data =
        typeof device.exportState === "function" ? await device.exportState().catch(() => null) : null;
      const token = await device.getGitHubToken().catch(() => null);
      if (!token || !status.user) return { stub: device, session };
      await canonical.claimGithubSession(secret, token, status.user, status.grantedScopes ?? []);
      // Only invalidate the device once its state landed: a failed import
      // leaves the source intact so the next request retries instead of
      // losing data. Image adoption is best-effort — source R2 objects are
      // never deleted, so a failure there loses nothing.
      let imported = true;
      if (data && typeof canonical.importState === "function") {
        try {
          await canonical.importState(data);
        } catch {
          imported = false;
        }
      }
      if (typeof canonical.adoptImagesFrom === "function") {
        await canonical.adoptImagesFrom(parsed.deviceId).catch(() => {});
      }
      if (imported && typeof device.clearGitHub === "function") {
        await device.clearGitHub().catch(() => {});
      }
    } else {
      await canonical.addSessionSecret(secret);
      // The canonical workspace is authoritative from here: revoke the
      // legacy bearer so the old cookie/sid cannot fork state through the
      // direct device mapping.
      if (typeof device.clearGitHub === "function") await device.clearGitHub().catch(() => {});
    }
    return { stub: canonical, session: { id: `${canonicalId}.${secret}`, isNew: true } };
  } catch {
    return { stub: device, session };
  }
}

/**
 * Same bearer check for the cookie-less app iframe endpoints, with one
 * exception: a `sid` identical to the request's own cookie belongs to the
 * browser `resolveAuth` just authorized (and migrated), so it uses the
 * resolved stub directly. Without this, a preview racing its page's first
 * migration would 401 on the stale device id and never rotate its cookie.
 */
export async function resolveSidForRequest(
  env: Env,
  req: Request,
  sid: string,
  resolved: DurableObjectStub<AppSession>,
): Promise<DurableObjectStub<AppSession> | null> {
  if (!SID_RE.test(sid)) return null;
  const cookieVal = readCookie(req, SESSION_COOKIE);
  if (cookieVal && sid === cookieVal) return resolved;
  return (await resolveSid(env, sid)) as unknown as DurableObjectStub<AppSession> | null;
}

/**
 * Same bearer check for the cookie-less app iframe endpoints: the `sid` is
 * the full bearer, and the canonical id alone is rejected. Legacy sids keep
 * the old token-presence behavior for mock-shaped stubs only.
 */
export async function resolveSid(env: Env, sid: string): Promise<(AuthStub & Record<string, any>) | null> {
  if (!SID_RE.test(sid)) return null;
  const parsed = parseSessionValue(sid);
  const direct = (name: string) => env.APP.get(env.APP.idFromName(name)) as unknown as AuthStub & Record<string, any>;
  if (!parsed) return null;
  if (parsed.kind === "canonical") {
    const stub = direct(parsed.canonicalId);
    try {
      if (typeof stub.checkSessionSecret === "function") {
        return (await stub.checkSessionSecret(parsed.secret)) ? stub : null;
      }
      return (await stub.getGitHubToken()) ? stub : null;
    } catch {
      return null;
    }
  }
  return direct(parsed.deviceId);
}

export function sessionJson(
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
