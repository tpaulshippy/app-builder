import { MEMBER_COOKIE } from "../share";
import { parseSessionValue } from "../session-key";
import { SESSION_COOKIE, corsJson, parseInviteCode, readCookie, requireAccess, sessionJson, stubShare, withMember, withSession } from "../server/auth";
import type { RouteCtx } from "../server/auth";

/** Shared-playground invite, join, status, preview, and leave. */
export async function handleShare(req: Request, ctx: RouteCtx): Promise<Response | null> {
  const { url, env, session, stub } = ctx;
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
      // The caller's authenticated credentials decide (never the stale
      // stored token): rotation after a logout/re-auth must not rebind
      // the owner slot to a revoked token or a different identity.
      const invite = await stub.createInvite({
        token: authed.access.token,
        user: authed.access.user,
        memberId: authed.access.memberId,
      });
      // The owner needs their member credential from here on: shared mode
      // requires it on every request, and without this cookie the invite
      // would lock the owner out of their own playground.
      const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
      withMember(headers, (invite as { memberSecret?: string }).memberSecret ?? null, req);
      // The routable object name — never the canonical bearer: the secret
      // after the dot authenticates the owner and must not leave the
      // server. Members route by this id and prove themselves with their
      // own member credential (see resolveAuth/requireAccess).
      const sessionParsed = parseSessionValue(session.id);
      const playgroundId =
        sessionParsed?.kind === "canonical" ? sessionParsed.canonicalId : session.id;
      return new Response(JSON.stringify({ ...invite, playgroundId }), { headers });
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
  return null;
}
