import { exchangeCode, getTokenScopes, getUser, loginUrl, requireEnv, tokenKind } from "../github";
import type { GitHubUser } from "../github";
import { canonicalIdForGithubUser, isCanonicalId, parseSessionValue } from "../session-key";
import { MEMBER_COOKIE } from "../share";
import type { ShareState } from "../share";
import {
  LOGIN_REQUIRED,
  LOGIN_STATE_COOKIE,
  SESSION_COOKIE,
  corsJson,
  readCookie,
  requireAccess,
  resolveSession,
  sessionJson,
  stubShare,
  withMember,
  withSession,
} from "../server/auth";
import type { RouteCtx } from "../server/auth";

/** GitHub OAuth login, status, and logout. */
export async function handleGithubAuth(req: Request, ctx: RouteCtx): Promise<Response | null> {
  const { url, env, session, stub } = ctx;
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
      //
      // Bare playground ids are public, so they must not travel alone: bind
      // an unguessable one-time nonce to this browser via an HttpOnly cookie
      // (the callback requires the two to match). Bearer/legacy states stay
      // as-is — they are already unguessable.
      let state = session.id;
      const headers = withSession(new Headers(), session);
      if (isCanonicalId(session.id)) {
        const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
        state = `${session.id}.${nonce}`;
        const secure = url.protocol === "https:" ? "; Secure" : "";
        headers.append(
          "set-cookie",
          `${LOGIN_STATE_COOKIE}=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax${secure}`,
        );
      }
      const target = loginUrl({ clientId, redirectUri, state });
      headers.append("location", target);
      return new Response(null, { status: 302, headers });
    } catch (e) {
      return sessionJson({ error: (e as Error).message }, session, 500);
    }
  }

  if (url.pathname === "/api/github/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    // `state` is a session value, or the bare id of a shared playground
    // (the join cookie — members log in from it; see below).
    if (!code || !state || (!parseSessionValue(state) && !isCanonicalId(state))) {
      return new Response("invalid oauth callback", { status: 400 });
    }
    // Login CSRF / session fixation guard: `state` is the session id sent in
    // the authorize URL, so only honor it when it matches the browser's own
    // session cookie. The login redirect sets that cookie (even for new
    // sessions), so a same-browser flow always round-trips; a crafted link
    // opened by a victim carries the attacker's state but the victim's
    // cookie and is rejected here before any token is stored.
    //
    // Bare playground ids are public, so the cookie match alone proves
    // nothing for them: logins started from a bare id also carry a
    // one-time nonce echoed in an HttpOnly cookie, and the playground is
    // accepted only when the two match (validated below).
    const sessionCookie = readCookie(req, SESSION_COOKIE);
    const loginEcho = readCookie(req, LOGIN_STATE_COOKIE);
    let playground: string | null = null;
    if (loginEcho && loginEcho === state) {
      const dot = state.lastIndexOf(".");
      const maybeId = dot === -1 ? "" : state.slice(0, dot);
      if (isCanonicalId(maybeId)) playground = maybeId;
    }
    if (sessionCookie !== state && sessionCookie !== playground) {
      return new Response("session mismatch — start login again from the GitHub tab", { status: 400 });
    }
    // Consuming the nonce: whatever happens below, this login attempt is
    // over, so a captured state cannot be replayed with a fresh code.
    const consumeNonce = (headers: Headers) => {
      if (playground) {
        const secure = url.protocol === "https:" ? "; Secure" : "";
        headers.append("set-cookie", `${LOGIN_STATE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`);
      }
      return headers;
    };
    try {
      const { clientId, clientSecret } = requireEnv(env as unknown as Record<string, string | undefined>);
      const redirectUri = `${url.origin}/api/github/callback`;
      const { token, grantedScopes } = await exchangeCode({ clientId, clientSecret, code, redirectUri });
      const user = await getUser(token);
      // `state` names the pre-login object: a canonical bearer contributes
      // its object name, a legacy value is the name itself.
      const targetParsed = parseSessionValue(state);
      const target = env.APP.get(
        env.APP.idFromName(targetParsed?.kind === "canonical" ? targetParsed.canonicalId : state),
      );
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
            // A bare playground id is public: without a validated login
            // nonce this state could be any browser's, so refuse before
            // touching member slots (login CSRF). Legacy/bearer states are
            // unguessable and need no nonce.
            if (!targetParsed && !playground) {
              return new Response("start login again from the GitHub tab", { status: 400 });
            }
            const secret = readCookie(req, MEMBER_COOKIE);
            const member = secret ? (share.members.find((m) => m.id === secret) ?? null) : null;
            if (!member) {
              return new Response("this playground is shared — join with an invite code first", {
                status: 403,
                headers: consumeNonce(new Headers()),
              });
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
        return new Response("could not verify playground membership — retry login", {
          status: 500,
          headers: consumeNonce(new Headers()),
        });
      }
      if (memberId) {
        const t = target as unknown as {
          setMemberToken: (id: string, token: string, user: GitHubUser) => Promise<void>;
        };
        await t.setMemberToken(memberId, token, user);
        // Members stay on the playground cookie: no canonical bearer is
        // minted for them, and the shared object is never adopted into a
        // personal one (see resolveAuth).
        return new Response(null, {
          status: 302,
          headers: consumeNonce(new Headers({ location: "/" })),
        });
      }
      if (!targetParsed) {
        // Bare object ids are only meaningful for shared playgrounds
        // (handled above). Anywhere else the state is invalid: the
        // canonical flow below must never treat a foreign object as the
        // caller's pre-login device — it would export and clear it.
        return new Response("invalid oauth callback", { status: 400 });
      }
      // Solo session: fall through to the canonical flow below.
      // Every login lands on the canonical per-user object, so a second
      // browser picks up the same files/chat. The cookie bearer is the
      // full `gh-<id>.<secret>`; the id alone never authenticates.
      const canonicalId = canonicalIdForGithubUser(user.id);
      const canonical = env.APP.get(env.APP.idFromName(canonicalId)) as unknown as Record<string, any>;
      const stateParsed = parseSessionValue(state);
      if (stateParsed?.kind === "canonical" && stateParsed.canonicalId === canonicalId) {
        // Re-login from a canonical bearer: refresh the token, keep the
        // browser's existing secret.
        if (typeof canonical.claimGithubSession === "function") {
          await canonical.claimGithubSession(stateParsed.secret, token, user, grantedScopes);
        } else {
          await canonical.setGitHubToken(token, user, grantedScopes);
        }
        const headers = new Headers({ location: "/" });
        headers.append(
          "set-cookie",
          `${SESSION_COOKIE}=${state}; Path=/; Max-Age=31536000; SameSite=Lax`,
        );
        return new Response(null, { status: 302, headers });
      }
      const secret = crypto.randomUUID();
      const bearer = `${canonicalId}.${secret}`;
      if (typeof canonical.claimGithubSession === "function") {
        const existing = await canonical.getGitHubToken().catch(() => null);
        if (!existing) {
          // Fresh canonical object: adopt the pre-login device state (if
          // any — the login gate normally keeps it empty) and its images.
          // The device is invalidated only after the import lands, so a
          // storage failure retries instead of losing state.
          const device = env.APP.get(env.APP.idFromName(state)) as unknown as Record<string, any>;
          const data = typeof device.exportState === "function"
            ? await device.exportState().catch(() => null)
            : null;
          await canonical.claimGithubSession(secret, token, user, grantedScopes);
          let imported = true;
          if (data && typeof canonical.importState === "function") {
            try {
              await canonical.importState(data);
            } catch {
              imported = false;
            }
          }
          if (typeof canonical.adoptImagesFrom === "function") {
            await canonical.adoptImagesFrom(state).catch(() => {});
          }
          if (imported && typeof device.clearGitHub === "function") {
            await device.clearGitHub().catch(() => {});
          }
        } else {
          await canonical.claimGithubSession(secret, token, user, grantedScopes);
          if (stateParsed?.kind === "legacy") {
            const device = env.APP.get(env.APP.idFromName(stateParsed.deviceId)) as unknown as Record<string, any>;
            if (typeof device.clearGitHub === "function") await device.clearGitHub().catch(() => {});
          }
        }
      } else {
        await canonical.setGitHubToken(token, user, grantedScopes);
      }
      const headers = new Headers({ location: "/" });
      headers.append(
        "set-cookie",
        `${SESSION_COOKIE}=${typeof canonical.claimGithubSession === "function" ? bearer : state}; Path=/; Max-Age=31536000; SameSite=Lax`,
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
      return sessionJson({ ok: true }, session);
    }
    const parsed = parseSessionValue(session.id);
    const expire = () => {
      const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
      headers.append("set-cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    };
    if (parsed?.kind === "canonical") {
      // Single-browser logout: revoke this bearer, atomically with the
      // last-browser wipe so a concurrent OAuth claim cannot interleave.
      // The last browser out also clears the token/link, matching the old
      // global logout. Mock-shaped stubs without logoutSecret fall back
      // to the two-step sequence.
      if (typeof stub.logoutSecret === "function") {
        await stub.logoutSecret(parsed.secret);
        return expire();
      }
      if (typeof stub.revokeSessionSecret === "function") {
        const { remaining } = await stub.revokeSessionSecret(parsed.secret);
        if (remaining <= 0) await stub.clearGitHub();
        return expire();
      }
    }
    await stub.clearGitHub();
    return sessionJson({ ok: true }, session);
  }
  return null;
}
