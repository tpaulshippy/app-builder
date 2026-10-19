/**
 * GitHub-keyed sessions: one canonical object per user (`gh-<id>`) shared
 * across browsers, authorized by per-browser bearer secrets. The edge Worker
 * is driven with fake Durable Objects (the real module is mocked out, as in
 * auth.test.ts); only the login gate + session routing behavior is pinned.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/session", () => ({
  AppSession: class MockAppSession {},
}));

import worker from "../src/index";
import type { Env } from "../src/index";
import { canonicalIdForGithubUser, isCanonicalId, parseSessionValue } from "../src/session-key";

const DEVICE = "dev-uuid-12345678";

class FakeDO {
  state: Record<string, unknown> = {};
  secrets: string[] = [];
  cleared = 0;
  constructor(readonly name: string) {}
  async getGitHubToken(): Promise<string | null> {
    return (this.state["github_token"] as string) ?? null;
  }
  async setGitHubToken(token: string, user: unknown, scopes: string[] = []): Promise<void> {
    this.state["github_token"] = token;
    this.state["github_user"] = user;
    this.state["github_scopes"] = scopes;
  }
  async getGitHubStatus(): Promise<{ connected: boolean; user: any; grantedScopes: string[] }> {
    const token = await this.getGitHubToken();
    return {
      connected: Boolean(token),
      user: (this.state["github_user"] as any) ?? null,
      grantedScopes: ((this.state["github_scopes"] as string[]) ?? []) as string[],
    };
  }
  async checkSessionSecret(secret: string): Promise<boolean> {
    return this.secrets.includes(secret);
  }
  async addSessionSecret(secret: string): Promise<void> {
    if (!this.secrets.includes(secret)) this.secrets.push(secret);
  }
  async claimGithubSession(secret: string, token: string, user: unknown, scopes: string[] = []): Promise<void> {
    await this.addSessionSecret(secret);
    await this.setGitHubToken(token, user, scopes);
  }
  async revokeSessionSecret(secret: string): Promise<{ remaining: number }> {
    this.secrets = this.secrets.filter((s) => s !== secret);
    return { remaining: this.secrets.length };
  }
  async logoutSecret(secret: string): Promise<{ remaining: number; cleared: boolean }> {
    this.secrets = this.secrets.filter((s) => s !== secret);
    if (this.secrets.length > 0) return { remaining: this.secrets.length, cleared: false };
    delete this.state["github_token"];
    delete this.state["github_user"];
    return { remaining: 0, cleared: true };
  }
  async exportState(): Promise<Record<string, unknown>> {
    return { ...this.state };
  }
  async importState(data: Record<string, unknown>): Promise<{ copied: number }> {
    let copied = 0;
    for (const [k, v] of Object.entries(data ?? {})) {
      if (!(k in this.state)) {
        this.state[k] = v;
        copied++;
      }
    }
    return { copied };
  }
  async adoptImagesFrom(): Promise<{ copied: number }> {
    return { copied: 0 };
  }
  async clearGitHub(): Promise<void> {
    delete this.state["github_token"];
    delete this.state["github_user"];
    this.secrets = [];
    this.cleared++;
  }
  async getFiles(): Promise<Record<string, string>> {
    return {};
  }
  async getMessages(): Promise<never[]> {
    return [];
  }
  async build(): Promise<unknown> {
    return { ok: true, files: {}, diagnostics: [] };
  }
  async appState(): Promise<unknown> {
    return { ok: true, tables: [], queries: {} };
  }
  async appMutate(): Promise<unknown> {
    return { ok: true };
  }
}

function makeEnv(): { env: Env; objects: Map<string, FakeDO> } {
  const objects = new Map<string, FakeDO>();
  const get = (name: string) => {
    let o = objects.get(name);
    if (!o) {
      o = new FakeDO(name);
      objects.set(name, o);
    }
    return o;
  };
  const env = {
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    APP: { idFromName: (name: string) => name, get: (name: string) => get(name) },
  } as unknown as Env;
  return { env, objects };
}

const get = (path: string, env: Env, cookie?: string) =>
  worker.fetch(
    new Request(`https://app.test${path}`, { headers: cookie ? { cookie: `ab_session=${cookie}` } : {} }),
    env,
  );

const post = (path: string, env: Env, cookie: string | undefined, body: unknown) =>
  worker.fetch(
    new Request(`https://app.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie: `ab_session=${cookie}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    env,
  );

const setCookieValue = (res: Response): string | null => {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const m = raw.match(/ab_session=([^;]*)/);
  return m ? decodeURIComponent(m[1] as string) : null;
};

describe("session-key shape", () => {
  it("round-trips canonical bearers and rejects bare ids", () => {
    expect(canonicalIdForGithubUser(42)).toBe("gh-42");
    expect(isCanonicalId("gh-42")).toBe(true);
    expect(isCanonicalId(DEVICE)).toBe(false);
    expect(parseSessionValue("gh-42.s3cr3t-abc123")).toEqual({
      kind: "canonical",
      canonicalId: "gh-42",
      secret: "s3cr3t-abc123",
    });
    expect(parseSessionValue(DEVICE)).toEqual({ kind: "legacy", deviceId: DEVICE });
    // Bare canonical ids match neither shape: they must never authenticate,
    // even when long enough to look like a legacy session (gh- + 5 digits).
    expect(parseSessionValue("gh-42")).toBeNull();
    expect(parseSessionValue("gh-12345")).toBeNull();
    expect(() => canonicalIdForGithubUser(0)).toThrow();
  });
});

describe("canonical bearer routing", () => {
  it("serves the shared object when the secret verifies", async () => {
    const { env, objects } = makeEnv();
    const target = objects.get("gh-42") ?? new FakeDO("gh-42");
    objects.set("gh-42", target);
    await target.setGitHubToken("gho_x", { login: "octo", id: 42 }, []);
    await target.addSessionSecret("s3cr3t-abc123");
    const res = await get("/api/state", env, "gh-42.s3cr3t-abc123");
    expect(res.status).toBe(200);
    // No rotation on steady-state use: the bearer stays valid as-is.
    expect(setCookieValue(res)).toBeNull();
  });

  it("rejects a forged bearer with an unknown secret", async () => {
    const { env, objects } = makeEnv();
    const target = new FakeDO("gh-42");
    objects.set("gh-42", target);
    await target.setGitHubToken("gho_x", { login: "octo", id: 42 }, []);
    await target.addSessionSecret("s3cr3t-abc123");
    const res = await get("/api/state", env, "gh-42.not-the-secret-xyz");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "github login required" });
    expect(target.secrets).toEqual(["s3cr3t-abc123"]);
  });

  it("never serves a bare canonical id, even a long one", async () => {
    const { env, objects } = makeEnv();
    // Eight chars: previously shaped exactly like a legacy session and
    // resolved to the victim's own object. Must now be anonymous/400.
    const target = new FakeDO("gh-12345");
    objects.set("gh-12345", target);
    await target.setGitHubToken("gho_x", { login: "octo", id: 12345 }, []);
    const cookieRes = await get("/api/state", env, "gh-12345");
    expect(cookieRes.status).toBe(401);
    const sidRes = await get("/api/app-state?sid=gh-12345", env);
    expect(sidRes.status).toBe(400);
    // The short form stays rejected too.
    expect((await get("/api/app-state?sid=gh-42", env)).status).toBe(400);
  });

  it("checks the secret on the cookie-less app endpoints too", async () => {
    const { env, objects } = makeEnv();
    const target = new FakeDO("gh-42");
    objects.set("gh-42", target);
    await target.setGitHubToken("gho_x", { login: "octo", id: 42 }, []);
    await target.addSessionSecret("s3cr3t-abc123");
    const good = await get("/api/app-state?sid=gh-42.s3cr3t-abc123", env);
    expect(good.status).toBe(200);
    const bad = await get("/api/app-state?sid=gh-42.guessed-secret-1", env);
    expect(bad.status).toBe(401);
  });

  it("guards the mutation endpoint with the same bearer check", async () => {
    const { env, objects } = makeEnv();
    const target = new FakeDO("gh-42");
    objects.set("gh-42", target);
    await target.setGitHubToken("gho_x", { login: "octo", id: 42 }, []);
    await target.addSessionSecret("s3cr3t-abc123");
    const mutate = (sid: string) =>
      post("/api/app-mutate", env, undefined, { sid, kind: "mutation", name: "m", args: [] });
    expect((await mutate("gh-42.s3cr3t-abc123")).status).toBe(200);
    expect((await mutate("gh-42.guessed-secret-1")).status).toBe(401);
    expect((await mutate("gh-12345")).status).toBe(400);
  });
});

describe("legacy migration", () => {
  it("moves a logged-in device to canonical once and reissues the cookie", async () => {
    const { env, objects } = makeEnv();
    const device = new FakeDO(DEVICE);
    objects.set(DEVICE, device);
    await device.setGitHubToken("gho_old", { login: "octo", id: 7 }, ["repo"]);
    device.state["files"] = { "a.ts": "x" };

    const first = await get("/api/state", env, DEVICE);
    expect(first.status).toBe(200);
    const bearer = setCookieValue(first);
    expect(bearer).toMatch(/^gh-7\.[A-Za-z0-9_-]{8,64}$/);

    const canonical = objects.get("gh-7");
    expect(canonical?.state["github_token"]).toBe("gho_old");
    expect(canonical?.state["files"]).toEqual({ "a.ts": "x" });
    // The device token is invalidated so the old bearer cannot fork state.
    expect(device.state["github_token"]).toBeUndefined();

    // The reissued bearer is steady-state: no further rotation.
    const second = await get("/api/state", env, bearer as string);
    expect(second.status).toBe(200);
    expect(setCookieValue(second)).toBeNull();
  });

  it("logs a second browser into the same canonical object via OAuth", async () => {
    const { env, objects } = makeEnv();
    const canonical = new FakeDO("gh-99");
    objects.set("gh-99", canonical);
    await canonical.setGitHubToken("gho_first", { login: "octo", id: 99 }, []);
    await canonical.addSessionSecret("first-browser-secret-1");

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const u = String(input);
      if (u.includes("login/oauth/access_token")) {
        return Response.json({ access_token: "gho_second", scope: "repo workflow" });
      }
      if (u.endsWith("/user")) {
        return Response.json({ login: "octo", id: 99 });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;
    try {
      const deviceId = "second-browser-device-1";
      // CSRF guard first: the same authorize state from another cookie is
      // rejected before any token is stored.
      const forged = await worker.fetch(
        new Request(`https://app.test/api/github/callback?code=c&state=${deviceId}`, {
          headers: { cookie: "ab_session=attacker-cookie-1" },
        }),
        env,
      );
      expect(forged.status).toBe(400);
      expect(canonical.state["github_token"]).toBe("gho_first");
      const cb = await worker.fetch(
        new Request(`https://app.test/api/github/callback?code=c&state=${deviceId}`, {
          headers: { cookie: `ab_session=${deviceId}` },
        }),
        env,
      );
      expect(cb.status).toBe(302);
      const bearer = setCookieValue(cb);
      expect(bearer).toMatch(/^gh-99\.[A-Za-z0-9_-]{8,64}$/);
      // Token refreshed, both browsers authorized, one shared object.
      expect(canonical.state["github_token"]).toBe("gho_second");
      expect(canonical.secrets).toHaveLength(2);
      const res = await get("/api/state", env, bearer as string);
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("shared logout", () => {
  it("revokes one browser but keeps the session for the others", async () => {
    const { env, objects } = makeEnv();
    const canonical = new FakeDO("gh-5");
    objects.set("gh-5", canonical);
    await canonical.setGitHubToken("gho_x", { login: "octo", id: 5 }, []);
    await canonical.addSessionSecret("browser-a-secret-1");
    await canonical.addSessionSecret("browser-b-secret-1");

    const out = await post("/api/github/logout", env, "gh-5.browser-a-secret-1", {});
    expect(out.status).toBe(200);
    expect(canonical.secrets).toEqual(["browser-b-secret-1"]);
    // Token survives while another browser remains.
    expect(await canonical.getGitHubToken()).toBe("gho_x");
    expect((await get("/api/state", env, "gh-5.browser-b-secret-1")).status).toBe(200);
    expect((await get("/api/state", env, "gh-5.browser-a-secret-1")).status).toBe(401);

    // The last browser out wipes the token, like the old global logout.
    await post("/api/github/logout", env, "gh-5.browser-b-secret-1", {});
    expect(await canonical.getGitHubToken()).toBeNull();
  });
});
