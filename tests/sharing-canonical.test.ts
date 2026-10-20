/**
 * Sharing on canonical sessions: the #30 + #34 reconciliation.
 *
 * The owner's canonical object (`gh-<userId>`) can host a shared playground.
 * These tests pin the combined behavior:
 *
 * - Invite from a canonical bearer names the bare object id — the session
 *   secret never leaves the server inside an invite code.
 * - Join by bare canonical id routes to the shared object (not a fresh one).
 * - Member git ops use the member's own token (`as`), never the owner's.
 * - Member OAuth links the member slot: no bearer minted, no adoption of the
 *   shared object, and no clearing of the owner's link. A non-member login
 *   against a shared playground is refused before any canonical flow runs
 *   (which would otherwise export + clear the playground).
 * - A legacy device cookie on a shared playground skips canonical migration.
 * - A bare id on a non-shared object stays anonymous (no solo auth by id).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/session", () => ({
  AppSession: class MockAppSession {},
}));

import worker from "../src/index";
import type { Env } from "../src/index";

const OWNER = { login: "dad", id: 1 };
const MEMBER = { login: "son", id: 2 };
const OWNER_BEARER_SECRET = "owner-secret-1234567890";
const OWNER_MS = "o".repeat(32);
const MEMBER_MS = "m".repeat(32);
const JOIN_MS = "n".repeat(32);
const INVITE_CODE = "Ab3dEf7hJk9M";

type Calls = Record<string, unknown[]>;

function makePlayground(name: string, calls: Calls, shared: boolean, token: string | null = "gho_owner") {
  const members = [
    { id: OWNER_MS, userId: 1, login: "dad", role: "owner", joinedAt: 1 },
    { id: MEMBER_MS, userId: 2, login: "son", role: "member", joinedAt: 2 },
  ];
  const memberTokens: Record<string, { token: string; user: { login: string; id: number } }> = {
    [OWNER_MS]: { token: "gho_owner", user: OWNER },
    [MEMBER_MS]: { token: "gho_son", user: MEMBER },
  };
  let enabled = shared;
  const record = (label: string, arg: unknown) => {
    (calls[`${name}:${label}`] ??= []).push(arg);
  };
  return {
    getGitHubToken: async () => token,
    getGitHubStatus: async () => ({
      connected: Boolean(token),
      user: token ? OWNER : null,
      linked: null,
      scopes: [],
      grantedScopes: [],
      tokenKind: "oauth",
    }),
    checkSessionSecret: async (s: string) => s === OWNER_BEARER_SECRET,
    addSessionSecret: async (s: string) => {
      record("addSessionSecret", s);
    },
    claimGithubSession: async (secret: string, token: string, user: unknown) => {
      record("claimGithubSession", { secret, token, user });
    },
    revokeSessionSecret: async (secret: string) => {
      record("revokeSessionSecret", secret);
      return { remaining: 1 };
    },
    logoutSecret: async (secret: string) => {
      record("logoutSecret", secret);
      return { remaining: 1, cleared: false };
    },
    setGitHubToken: async (token: string, user: unknown) => {
      record("setGitHubToken", { token, user });
    },
    exportState: async () => {
      record("exportState", true);
      return {};
    },
    getShare: async () =>
      enabled
        ? {
            enabled: true,
            owner: { userId: 1, login: "dad" },
            members,
            invite: { code: INVITE_CODE, createdAt: 1, expiresAt: Date.now() + 1000 },
          }
        : null,
    getMemberToken: async (id: string) => memberTokens[id]?.token ?? null,
    getMemberUser: async (id: string) => memberTokens[id]?.user ?? null,
    setMemberToken: async (id: string, token: string, user: unknown) => {
      record("setMemberToken", { id, token, user });
      if (typeof id === "string" && typeof token === "string") {
        memberTokens[id] = { token, user: user as { login: string; id: number } };
      }
    },
    createInvite: async (caller: unknown) => {
      record("createInvite", caller);
      enabled = true;
      return { code: INVITE_CODE, expiresAt: Date.now() + 1000, memberSecret: OWNER_MS };
    },
    joinPlayground: async (code: string) => {
      record("joinPlayground", code);
      if (code !== INVITE_CODE) throw new Error("invite is invalid or expired");
      return { memberSecret: JOIN_MS };
    },
    clearMemberToken: async (id: string) => {
      record("clearMemberToken", id);
    },
    clearGitHub: async () => {
      record("clearGitHub", true);
    },
    commitPush: async (message: string, as?: unknown) => {
      record("commitPush", { message, as });
      return { output: "pushed" };
    },
    getBranches: async (as?: unknown) => {
      record("getBranches", { as });
      return { current: "main", branches: [], linked: null };
    },
    gitStatus: async () => "clean",
    getFiles: async () => {
      record("getFiles", true);
      return {};
    },
    getMessages: async () => [],
    build: async () => ({ ok: true, files: {}, diagnostics: [] }),
    getFilesVersion: async () => 3,
    getTurnStatus: async () => ({ active: false, actor: null, startedAt: null, queued: 0 }),
    isTurnActive: async () => false,
    getShareStatus: async () => ({ shared: true, joined: true }),
  };
}

function makeEnv() {
  const calls: Calls = {};
  const objects = new Map<string, ReturnType<typeof makePlayground>>();
  const get = (name: string) => {
    let o = objects.get(name);
    if (!o) {
      // Unknown objects are bare stubs: no token, no sharing state.
      o = makePlayground(name, calls, false, null);
      objects.set(name, o);
    }
    return o;
  };
  const env = {
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    APP: { idFromName: (name: string) => name, get: (name: string) => get(name) },
  } as unknown as Env;
  const shared = (name: string) => {
    const o = makePlayground(name, calls, true);
    objects.set(name, o);
    return o;
  };
  return { env, objects, calls, shared };
}

async function call(env: Env, path: string, init?: RequestInit, cookies = "") {
  return worker.fetch(
    new Request(`https://app.test${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...(cookies ? { cookie: cookies } : {}) },
    }),
    env,
  );
}

const post = (env: Env, path: string, body: unknown, cookies = "") =>
  call(
    env,
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    cookies,
  );

function setCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? raw.split(/,(?=[^;]+=[^;]*)/) : [];
}

function stubOAuth(token: string, user: { login: string; id: number }) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const u = String(input);
    if (u.includes("login/oauth/access_token")) {
      return Response.json({ access_token: token, scope: "repo workflow" });
    }
    if (u.endsWith("/user")) {
      return Response.json(user);
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

describe("sharing on canonical sessions", () => {
  it("invite from a canonical bearer names the bare object id, never the secret", async () => {
    const { env, objects, calls } = makeEnv();
    objects.set("gh-1", makePlayground("gh-1", calls, false));
    const res = await post(env, "/api/share/invite", {}, `ab_session=gh-1.${OWNER_BEARER_SECRET}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { playgroundId?: string; code?: string };
    expect(body.playgroundId).toBe("gh-1");
    expect(body.playgroundId).not.toContain(OWNER_BEARER_SECRET);
    expect(body.code).toBe(INVITE_CODE);
    expect(setCookies(res).some((c) => c.startsWith("ab_member="))).toBe(true);
    expect(calls["gh-1:createInvite"]).toHaveLength(1);
  });

  it("join by bare canonical id lands on the shared object", async () => {
    const { env, calls, shared } = makeEnv();
    shared("gh-1");
    const res = await post(env, "/api/share/join", { code: `gh-1.${INVITE_CODE}` });
    expect(res.status).toBe(200);
    const jar = setCookies(res);
    expect(jar.some((c) => c.startsWith("ab_session=gh-1;"))).toBe(true);
    expect(jar.some((c) => c.startsWith("ab_member="))).toBe(true);
    // Routed to the pre-existing shared object — the only join call anywhere.
    expect(calls["gh-1:joinPlayground"]).toEqual([INVITE_CODE]);
    expect(Object.keys(calls).filter((k) => k.endsWith(":joinPlayground"))).toEqual(["gh-1:joinPlayground"]);
  });

  it("member git ops use the member token, never the owner's", async () => {
    const { env, calls, shared } = makeEnv();
    shared("gh-1");
    const cookies = `ab_session=gh-1; ab_member=${MEMBER_MS}`;
    const commit = await post(env, "/api/git/commit", { message: "hi" }, cookies);
    expect(commit.status).toBe(200);
    const push = calls["gh-1:commitPush"]?.[0] as { message?: string; as?: { token?: string; user?: unknown } };
    expect(push?.message).toBe("hi");
    expect(push?.as?.token).toBe("gho_son");
    expect(push?.as?.user).toEqual(MEMBER);
    const branches = await call(env, "/api/git/branches", undefined, cookies);
    expect(branches.status).toBe(200);
    const listed = calls["gh-1:getBranches"]?.[0] as { as?: { token?: string } };
    expect(listed?.as?.token).toBe("gho_son");
    expect(calls["gh-1:clearGitHub"] ?? []).toEqual([]);
  });

  it("member OAuth links the member slot without minting a bearer", async () => {
    const { env, calls, shared } = makeEnv();
    shared("gh-1");
    const restore = stubOAuth("gho_son_new", MEMBER);
    try {
      const started = await call(env, "/api/github/login", undefined, `ab_session=gh-1; ab_member=${MEMBER_MS}`);
      expect(started.status).toBe(302);
      const state = new URL(started.headers.get("location") as string).searchParams.get("state") as string;
      expect(state.startsWith("gh-1.")).toBe(true);
      const nonceCookie = setCookies(started).find((c) => c.startsWith("ab_login_state=")) as string;
      expect(decodeURIComponent((nonceCookie.split("=")[1] ?? "").split(";")[0] ?? "")).toBe(state);
      const jar = `ab_session=gh-1; ab_member=${MEMBER_MS}; ${nonceCookie.split(";")[0]}`;
      const cb = await call(env, `/api/github/callback?code=c&state=${state}`, undefined, jar);
      expect(cb.status).toBe(302);
      expect(calls["gh-1:setMemberToken"]).toEqual([{ id: MEMBER_MS, token: "gho_son_new", user: MEMBER }]);
      expect(setCookies(cb).some((c) => c.startsWith("ab_session="))).toBe(false);
      expect(calls["gh-1:claimGithubSession"] ?? []).toEqual([]);
      expect(calls["gh-1:setGitHubToken"] ?? []).toEqual([]);
      expect(calls["gh-1:clearGitHub"] ?? []).toEqual([]);
      // The nonce is one-time: replaying the same state with a fresh code fails.
      const replay = await call(
        env,
        `/api/github/callback?code=c2&state=${state}`,
        undefined,
        `ab_session=gh-1; ab_member=${MEMBER_MS}`,
      );
      expect(replay.status).toBe(400);
      expect(calls["gh-1:setMemberToken"]).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("callback with a bare-id state but no login nonce is rejected, even for members", async () => {
    const { env, calls, shared } = makeEnv();
    shared("gh-1");
    const restore = stubOAuth("gho_attacker", { login: "mallory", id: 9 });
    try {
      // No prior /api/github/login: the state is public, so it proves nothing.
      const cb = await call(env, "/api/github/callback?code=c&state=gh-1", undefined, `ab_session=gh-1; ab_member=${MEMBER_MS}`);
      expect(cb.status).toBe(400);
      expect(calls["gh-1:setMemberToken"] ?? []).toEqual([]);
      expect(calls["gh-1:claimGithubSession"] ?? []).toEqual([]);
      expect(calls["gh-1:clearGitHub"] ?? []).toEqual([]);
    } finally {
      restore();
    }
  });

  it("non-member login against a shared playground is refused before any canonical flow", async () => {
    const { env, calls, shared } = makeEnv();
    shared("gh-1");
    const restore = stubOAuth("gho_attacker", { login: "mallory", id: 9 });
    try {
      const started = await call(env, "/api/github/login", undefined, `ab_session=gh-1`);
      const state = new URL(started.headers.get("location") as string).searchParams.get("state") as string;
      const nonceCookie = setCookies(started).find((c) => c.startsWith("ab_login_state=")) as string;
      const cb = await call(env, `/api/github/callback?code=c&state=${state}`, undefined, `ab_session=gh-1; ${nonceCookie.split(";")[0]}`);
      expect(cb.status).toBe(403);
      // The canonical adoption path would export + clear the playground.
      expect(calls["gh-1:claimGithubSession"] ?? []).toEqual([]);
      expect(calls["gh-1:setGitHubToken"] ?? []).toEqual([]);
      expect(calls["gh-1:clearGitHub"] ?? []).toEqual([]);
      expect(calls["gh-1:exportState"] ?? []).toEqual([]);
    } finally {
      restore();
    }
  });

  it("legacy-state member login on a shared playground needs no nonce", async () => {
    const { env, objects, calls } = makeEnv();
    const device = makePlayground("legacy-device-0001", calls, true);
    objects.set("legacy-device-0001", device);
    const restore = stubOAuth("gho_son_new", MEMBER);
    try {
      // Legacy session ids are unguessable, so the cookie match still suffices.
      const cb = await call(
        env,
        "/api/github/callback?code=c&state=legacy-device-0001",
        undefined,
        `ab_session=legacy-device-0001; ab_member=${MEMBER_MS}`,
      );
      expect(cb.status).toBe(302);
      expect(calls["legacy-device-0001:setMemberToken"]).toEqual([{ id: MEMBER_MS, token: "gho_son_new", user: MEMBER }]);
      expect(Object.keys(calls).some((k) => k.endsWith(":claimGithubSession"))).toBe(false);
    } finally {
      restore();
    }
  });

  it("legacy device cookie on a shared playground skips canonical migration", async () => {
    const { env, objects, calls } = makeEnv();
    const device = makePlayground("legacy-device-0001", calls, true);
    objects.set("legacy-device-0001", device);
    const res = await call(env, "/api/state", undefined, `ab_session=legacy-device-0001; ab_member=${MEMBER_MS}`);
    expect(res.status).toBe(200);
    // Served from the shared device object; no canonical object was adopted.
    expect(calls["legacy-device-0001:getFiles"]?.length).toBeGreaterThan(0);
    expect(objects.has("gh-1")).toBe(false);
    expect(Object.keys(calls).some((k) => k.endsWith(":claimGithubSession"))).toBe(false);
    expect(Object.keys(calls).some((k) => k.endsWith(":clearGitHub"))).toBe(false);
  });

  it("bare-id callback on a non-shared object is rejected before any adoption", async () => {
    const { env, objects, calls } = makeEnv();
    objects.set("gh-9", makePlayground("gh-9", calls, false));
    const restore = stubOAuth("gho_owner", OWNER);
    try {
      const cb = await call(env, `/api/github/callback?code=c&state=gh-9`, undefined, `ab_session=gh-9`);
      expect(cb.status).toBe(400);
      // The foreign object is never treated as a pre-login device.
      expect(Object.keys(calls).some((k) => k.endsWith(":claimGithubSession"))).toBe(false);
      expect(Object.keys(calls).some((k) => k.endsWith(":clearGitHub"))).toBe(false);
      expect(Object.keys(calls).some((k) => k.endsWith(":exportState"))).toBe(false);
    } finally {
      restore();
    }
  });

  it("bare id on a non-shared object stays anonymous", async () => {
    const { env, calls } = makeEnv();
    const res = await call(env, "/api/state", undefined, `ab_session=gh-9`);
    expect(res.status).toBe(401);
    expect(calls["gh-9:getFiles"] ?? []).toEqual([]);
  });
});
