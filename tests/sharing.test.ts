/**
 * Issue #30 (live sharing): two members, one playground.
 *
 * - Solo sessions keep the object-has-token gate.
 * - Shared playgrounds require caller-has-access: the request must carry the
 *   member's own `ab_member` credential; the token used is the member's own.
 * - Joining mints a credential (never copies the cookie); only the owner
 *   invites; git ops receive the actor (`as`), never an owner-token fallback.
 * - Whole-FileMap saves carry baseVersion; a teammate persisting first 409s
 *   with the server files (reload prompt, no silent overwrite).
 * - Turn conflicts name the running actor.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/session", () => ({
  AppSession: class MockAppSession {},
}));

import worker from "../src/index";
import type { Env } from "../src/index";

const OWNER_SECRET = "o".repeat(32);
const MEMBER_SECRET = "m".repeat(32);

type FakeOpts = {
  shared: boolean;
  memberTokens?: Record<string, string>;
  filesVersion?: number;
  turn?: { active: boolean; actor: string | null };
  role?: "owner" | "member";
};

function fakeStub(calls: Record<string, unknown[]>, opts: FakeOpts) {
  const members = [
    { id: OWNER_SECRET, userId: 1, login: "dad", role: "owner", joinedAt: 1 },
    { id: MEMBER_SECRET, userId: 2, login: "son", role: "member", joinedAt: 2 },
  ];
  const tokens: Record<string, string> = {
    [OWNER_SECRET]: "gho_owner",
    [MEMBER_SECRET]: "gho_son",
    ...(opts.memberTokens ?? {}),
  };
  let version = opts.filesVersion ?? 3;
  let storedFiles: Record<string, string> = { "server/index.ts": "new" };
  const previewGrants = new Set<string>();
  const record = (name: string, arg: unknown) => {
    (calls[name] ??= []).push(arg);
  };
  return {
    getGitHubToken: async () => "gho_owner",
    getGitHubStatus: async () => ({
      connected: true,
      user: { login: "dad", id: 1 },
      linked: null,
      scopes: [],
      grantedScopes: [],
      tokenKind: "oauth",
    }),
    getShare: async () =>
      opts.shared
        ? {
            enabled: true,
            owner: { userId: 1, login: "dad" },
            members,
            invite: { code: "Ab3dEf7hJk9M", createdAt: 1, expiresAt: Date.now() + 1000 },
          }
        : null,
    getMemberToken: async (id: string) => tokens[id] ?? null,
    getMemberUser: async (id: string) =>
      id === OWNER_SECRET ? { login: "dad", id: 1 } : id === MEMBER_SECRET ? { login: "son", id: 2 } : null,
    getShareStatus: async (viewerMemberId?: string | null) =>
      opts.shared
        ? {
            shared: true,
            members: members.map(({ login, role, joinedAt }) => ({ login, role, joinedAt })),
            owner: { userId: 1, login: "dad" },
            invite:
              viewerMemberId === OWNER_SECRET
                ? { code: "Ab3dEf7hJk9M", expiresAt: Date.now() + 1000 }
                : null,
            turn: { active: false, actor: null, startedAt: null, queued: 0 },
            audit: [],
            filesVersion: version,
          }
        : {
            shared: false,
            members: [],
            owner: null,
            invite: null,
            turn: { active: false, actor: null, startedAt: null, queued: 0 },
            audit: [],
            filesVersion: version,
          },
    getFilesVersion: async () => version,
    getTurnStatus: async () => ({
      active: opts.turn?.active ?? false,
      actor: opts.turn?.actor ?? null,
      startedAt: null,
      queued: 0,
    }),
    isTurnActive: async () => opts.turn?.active ?? false,
    getFiles: async () => storedFiles,
    getMessages: async () => [],
    build: async () => ({ ok: true, files: {}, diagnostics: [] }),
    setFiles: async (f: unknown) => {
      record("setFiles", f);
      storedFiles = { ...(f as Record<string, string>) };
      version++;
    },
    saveFilesIfVersion: async (f: unknown, base: unknown) => {
      record("saveFilesIfVersion", { files: f, base });
      if (typeof base === "number" && base !== version) {
        return { ok: false, files: storedFiles, version };
      }
      storedFiles = { ...(f as Record<string, string>) };
      version++;
      return { ok: true, version };
    },
    saveFileIfVersion: async (path: string, content: string, base: unknown) => {
      record("saveFileIfVersion", { path, content, base });
      if (typeof base === "number" && base !== version) {
        return { ok: false, files: storedFiles, version };
      }
      storedFiles = { ...storedFiles, [path]: content };
      version++;
      return { ok: true, files: storedFiles, version };
    },
    snapshotChat: async (title: string, files: unknown, by?: string) => {
      record("snapshotChat", { title, files, by });
      return { id: "c1", title };
    },
    resumeChat: async (id: string, by?: string) => {
      record("resumeChat", { id, by });
      return { messages: [], files: {}, built: { ok: true }, repo: null, linked: null, repoNote: "" };
    },
    commitPush: async (message: string, as?: unknown) => {
      record("commitPush", { message, as });
      return { output: "pushed" };
    },
    gitStatus: async () => "clean",
    cloneFromGitHub: async (o: unknown) => {
      record("cloneFromGitHub", o);
      return { files: {}, meta: {}, skipped: [], output: "", kept: 0 };
    },
    pullFromRemote: async (as?: unknown) => {
      record("pullFromRemote", { as });
      return { files: {}, skipped: [], output: "", conflict: false };
    },
    createInvite: async (caller: unknown) => {
      record("createInvite", caller ?? opts.role ?? "owner");
      if ((opts.role ?? "owner") !== "owner") throw new Error("not owner");
      return { code: "Ab3dEf7hJk9M", expiresAt: Date.now() + 1000, memberSecret: OWNER_SECRET };
    },
    joinPlayground: async (code: string) => {
      record("joinPlayground", code);
      if (code !== "Ab3dEf7hJk9M") throw new Error("invite is invalid or expired");
      return { memberSecret: "n".repeat(32) };
    },
    leavePlayground: async (id: string) => {
      record("leavePlayground", id);
      if (id === OWNER_SECRET) throw new Error("the owner cannot leave a shared playground");
    },
    clearMemberToken: async (id: string) => {
      record("clearMemberToken", id);
    },
    clearGitHub: async () => {
      record("clearGitHub", true);
    },
    mintPreviewToken: async (memberId: string | null) => {
      record("mintPreviewToken", memberId);
      const preview = `preview-${memberId ?? "solo"}-token`;
      previewGrants.add(preview);
      return { preview, expiresAt: Date.now() + 3600_000 };
    },
    checkPreviewToken: async (preview: unknown) => {
      if (typeof preview === "string" && previewGrants.has(preview)) {
        return { memberId: MEMBER_SECRET };
      }
      return null;
    },
    appState: async () => ({ ok: true, tables: [], queries: {} }),
    appMutate: async () => ({ ok: true }),
    fetch: async (req: Request) => {
      try {
        record("forwarded", await req.json());
      } catch {
        record("forwarded", null);
      }
      return new Response(`data: ${JSON.stringify({ type: "done", messages: [], files: {} })}\n\n`, {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  };
}

function testEnv(stub: unknown): Env {
  return {
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    APP: { idFromName: (name: string) => name, get: () => stub },
  } as unknown as Env;
}

const call = (path: string, env: Env, init?: RequestInit, cookies = "") =>
  worker.fetch(
    new Request(`https://app.test${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...(cookies ? { cookie: cookies } : {}) },
    }),
    env,
  );

const post = (path: string, env: Env, body: unknown, cookies = "") =>
  call(path, env, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, cookies);

describe("issue #30 live sharing", () => {
  it("keeps solo sessions on the object-has-token gate", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: false }));
    const res = await call("/api/state", env, undefined, "ab_session=solo1234");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.version).toBe(3);
    expect(body.share.shared).toBe(false);
  });

  it("rejects shared-playground reads without a member credential", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: true }));
    const res = await call("/api/state", env, undefined, "ab_session=playground1");
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, any>).error).toMatch(/not a member/);
  });

  it("requires the member's own login on a shared playground", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: true, memberTokens: { [MEMBER_SECRET]: null as unknown as string } }));
    const res = await call("/api/state", env, undefined, `ab_session=playground1; ab_member=${MEMBER_SECRET}`);
    expect(res.status).toBe(401);
  });

  it("attributes git pushes to the acting member, never the owner", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: true }));
    const cookies = `ab_session=playground1; ab_member=${MEMBER_SECRET}`;
    const res = await post("/api/git/commit", env, { message: "son edit" }, cookies);
    expect(res.status).toBe(200);
    const commits = calls.commitPush as Array<{ message: string; as: { token: string; user: { login: string } } }>;
    expect(commits).toHaveLength(1);
    expect(commits[0]?.as.token).toBe("gho_son");
    expect(commits[0]?.as.user.login).toBe("son");
  });

  it("lets only the owner invite", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: true, role: "member" }));
    const cookies = `ab_session=playground1; ab_member=${MEMBER_SECRET}`;
    // The edge role comes from the playground roster (member), so this 403s
    // before the stub is even asked.
    const res = await call("/api/share/invite", env, { method: "POST" }, cookies);
    expect(res.status).toBe(403);
    expect(calls.createInvite ?? []).toEqual([]);
  });

  it("passes the caller's credentials into createInvite (never the stale stored token)", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: true }));
    const res = await post("/api/share/invite", env, {}, `ab_session=playground1; ab_member=${OWNER_SECRET}`);
    expect(res.status).toBe(200);
    // Rotation must rebind the owner slot to these credentials, not to
    // whatever the stored solo token holds after a logout/re-auth.
    expect(calls.createInvite).toEqual([
      { token: "gho_owner", user: { login: "dad", id: 1 }, memberId: OWNER_SECRET },
    ]);
  });

  it("redeems invites by minting a credential, not by copying the cookie", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: true }));
    const bad = await post("/api/share/join", env, { code: "nope" });
    expect(bad.status).toBe(400);
    const pg = "playground1";
    const minted = "n".repeat(32);
    const good = await post(
      "/api/share/join",
      env,
      { code: `${pg}.Ab3dEf7hJk9M` },
      `ab_session=solo9; ab_member=${"o".repeat(32)}`,
    );
    expect(good.status).toBe(200);
    const setCookies = good.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith(`ab_session=${pg};`))).toBe(true);
    // The exact minted credential lands in the cookie (replacing the old
    // member secret), and no GitHub token ever does.
    expect(setCookies.some((c) => c.startsWith(`ab_member=${minted};`))).toBe(true);
    expect(JSON.stringify(setCookies)).not.toContain("gho_");
  });

  it("sets the owner's member credential when the first invite is created", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: false }));
    const res = await post("/api/share/invite", env, {}, "ab_session=solo1234");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.code).toBe("Ab3dEf7hJk9M");
    expect(body.playgroundId).toBe("solo1234");
    // The owner keeps working without re-login: their credential is set now,
    // before shared mode starts gating on it.
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith(`ab_member=${OWNER_SECRET};`))).toBe(true);
  });

  it("409s stale whole-FileMap saves with the server files (reload prompt)", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: true, filesVersion: 8 }));
    const cookies = `ab_session=playground1; ab_member=${MEMBER_SECRET}`;
    const stale = await post("/api/files", env, { files: {}, baseVersion: 7 }, cookies);
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as Record<string, any>;
    expect(body.error).toMatch(/teammate edited — reload/);
    expect(body.files).toEqual({ "server/index.ts": "new" });
    expect(body.version).toBe(8);
    expect(calls.setFiles ?? []).toEqual([]);
    expect(calls.saveFilesIfVersion).toHaveLength(1);
    const fresh = await post("/api/files", env, { files: { "server/index.ts": "mine" }, baseVersion: 8 }, cookies);
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as Record<string, any>).files).toEqual({ "server/index.ts": "mine" });
  });

  it("requires the version on shared saves instead of silently overwriting", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: true, filesVersion: 8 }));
    const cookies = `ab_session=playground1; ab_member=${MEMBER_SECRET}`;
    const bulk = await post("/api/files", env, { files: {} }, cookies);
    expect(bulk.status).toBe(409);
    expect(((await bulk.json()) as Record<string, any>).error).toMatch(/needs the files version/);
    const single = await post("/api/file", env, { path: "a.ts", content: "x" }, cookies);
    expect(single.status).toBe(409);
    expect(((await single.json()) as Record<string, any>).error).toMatch(/needs the files version/);
    expect(calls.saveFilesIfVersion ?? []).toEqual([]);
    expect(calls.saveFileIfVersion ?? []).toEqual([]);
    // Solo sessions keep the opt-in guard for older clients.
    const soloCalls: Record<string, unknown[]> = {};
    const soloEnv = testEnv(fakeStub(soloCalls, { shared: false }));
    const solo = await post("/api/files", soloEnv, { files: {} }, "ab_session=solo1");
    expect(solo.status).toBe(200);
  });

  it("names the running actor in turn conflicts", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: true, turn: { active: true, actor: "son" } }));
    const cookies = `ab_session=playground1; ab_member=${OWNER_SECRET}`;
    const res = await post("/api/files", env, { files: {} }, cookies);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, any>).error).toContain("son");
  });

  it("shows the invite code to the owner only", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: true }));
    const ownerRes = await call("/api/share/status", env, undefined, `ab_session=playground1; ab_member=${OWNER_SECRET}`);
    expect(((await ownerRes.json()) as Record<string, any>).invite?.code).toBe("Ab3dEf7hJk9M");
    const memberRes = await call("/api/share/status", env, undefined, `ab_session=playground1; ab_member=${MEMBER_SECRET}`);
    const memberBody = (await memberRes.json()) as Record<string, any>;
    expect(memberBody.shared).toBe(true);
    expect(memberBody.invite).toBeNull();
    expect(JSON.stringify(memberBody)).not.toContain(MEMBER_SECRET);
    expect(JSON.stringify(memberBody)).not.toContain(OWNER_SECRET);
    const anon = await call("/api/share/status", env, undefined, "ab_session=playground1");
    expect(((await anon.json()) as Record<string, any>).joined).toBe(false);
  });

  it("records who checkpointed and resumed", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: true }));
    const cookies = `ab_session=playground1; ab_member=${MEMBER_SECRET}`;
    await post("/api/chats/snapshot", env, { title: "t" }, cookies);
    await post("/api/chats/snap00001/resume", env, {}, cookies);
    expect(calls.snapshotChat).toEqual([{ title: "t", files: undefined, by: "son" }]);
    expect(calls.resumeChat).toEqual([{ id: "snap00001", by: "son" }]);
  });

  it("member logout drops only their token, never the shared link", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: true }));
    const cookies = `ab_session=playground1; ab_member=${MEMBER_SECRET}`;
    const res = await post("/api/github/logout", env, {}, cookies);
    expect(res.status).toBe(200);
    expect(calls.clearMemberToken).toEqual([MEMBER_SECRET]);
    expect(calls.clearGitHub ?? []).toEqual([]);
  });

  it("authenticates the sid-selected object, not the cookie one", async () => {
    // Distinct stubs keyed by DO id: the sid endpoints must gate on the
    // sid-selected object's token even when the cookie names another object.
    const anonCalls: Record<string, unknown[]> = {};
    const liveCalls: Record<string, unknown[]> = {};
    const byId: Record<string, unknown> = {
      anonsession1: fakeStub(anonCalls, { shared: false, memberTokens: {} }),
      livesession1: fakeStub(liveCalls, { shared: false }),
    };
    // Anonymous stub holds no token.
    (byId.anonsession1 as { getGitHubToken: unknown }).getGitHubToken = async () => null;
    // Legacy shape without preview capabilities: exercises the pre-preview
    // fallback (object-token gate only), keeping this test about sid-vs-cookie.
    for (const stub of Object.values(byId)) {
      delete (stub as Record<string, unknown>).checkPreviewToken;
      delete (stub as Record<string, unknown>).mintPreviewToken;
    }
    const keyedEnv = {
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
      APP: {
        idFromName: (name: string) => name,
        get: (id: string) => byId[id] ?? byId.anonsession1,
      },
    } as unknown as Env;
    const keyedCall = (path: string, init?: RequestInit, cookies = "") =>
      worker.fetch(
        new Request(`https://app.test${path}`, {
          ...init,
          headers: { ...(init?.headers ?? {}), ...(cookies ? { cookie: cookies } : {}) },
        }),
        keyedEnv,
      );
    // Anonymous sid-selected object: 401 on state, mutate, and page — even
    // when the cookie names the live session.
    const liveCookies = "ab_session=livesession1";
    expect((await keyedCall("/api/app-state?sid=anonsession1", undefined, liveCookies)).status).toBe(401);
    expect((await keyedCall("/api/app?sid=anonsession1", undefined, liveCookies)).status).toBe(401);
    const mutateAnon = await keyedCall(
      "/api/app-mutate",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sid: "anonsession1", kind: "mutation", name: "m", args: [] }) },
      liveCookies,
    );
    expect(mutateAnon.status).toBe(401);
    // Live sid-selected object: reachable with an unrelated cookie.
    expect((await keyedCall("/api/app-state?sid=livesession1", undefined, "ab_session=anonsession1")).status).toBe(200);
    expect((await keyedCall("/api/app?sid=livesession1", undefined, "ab_session=anonsession1")).status).toBe(200);
  });

  it("runs agent turns as the sending member, never the owner", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: true }));
    const cookies = `ab_session=playground1; ab_member=${MEMBER_SECRET}`;
    const res = await call(
      "/api/chat",
      env,
      { method: "POST", headers: { "content-type": "application/json", "x-provider-key": "k" }, body: JSON.stringify({ message: "hi" }) },
      cookies,
    );
    expect(res.status).toBe(200);
    const forwarded = calls.forwarded as Array<Record<string, unknown>>;
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.author).toBe("son");
    expect(forwarded[0]?.memberId).toBe(MEMBER_SECRET);
  });

  it("gates the sandboxed app endpoints on a preview capability", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: true }));
    const cookies = `ab_session=playground1; ab_member=${MEMBER_SECRET}`;
    // Bare sid: the invite URL discloses it, so it must not suffice alone.
    expect((await call("/api/app-state?sid=playground1", env, undefined, cookies)).status).toBe(401);
    expect((await call("/api/app?sid=playground1", env, undefined, cookies)).status).toBe(401);
    const mutateBare = await post("/api/app-mutate", env, { sid: "playground1", kind: "mutation", name: "m", args: [] }, cookies);
    expect(mutateBare.status).toBe(401);
    // Minted by the member-gated parent: state, mutate, and page all pass.
    const minted = (await (await post("/api/share/preview", env, {}, cookies)).json()) as Record<string, any>;
    expect(typeof minted.preview).toBe("string");
    const withPreview = `preview=${encodeURIComponent(minted.preview)}`;
    expect((await call(`/api/app-state?sid=playground1&${withPreview}`, env, undefined, cookies)).status).toBe(200);
    expect((await call(`/api/app?sid=playground1&${withPreview}`, env, undefined, cookies)).status).toBe(200);
    const mutateOk = await post("/api/app-mutate", env, { sid: "playground1", preview: minted.preview, kind: "mutation", name: "m", args: [] }, cookies);
    expect(mutateOk.status).toBe(200);
    // A forged capability fails closed.
    expect((await call("/api/app-state?sid=playground1&preview=nope", env, undefined, cookies)).status).toBe(401);
  });

  it("refuses owner leave but allows member leave", async () => {
    const calls: Record<string, unknown[]> = {};
    const env = testEnv(fakeStub(calls, { shared: true }));
    const ownerRes = await post("/api/share/leave", env, {}, `ab_session=playground1; ab_member=${OWNER_SECRET}`);
    expect(ownerRes.status).toBe(500);
    expect(((await ownerRes.json()) as Record<string, any>).error).toMatch(/owner cannot leave/);
    const memberRes = await post("/api/share/leave", env, {}, `ab_session=playground1; ab_member=${MEMBER_SECRET}`);
    expect(memberRes.status).toBe(200);
    // The owner attempt records before rejecting; only the member departs.
    expect(calls.leavePlayground).toEqual([OWNER_SECRET, MEMBER_SECRET]);
    const setCookies = memberRes.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith("ab_member=;"))).toBe(true);
  });
});
