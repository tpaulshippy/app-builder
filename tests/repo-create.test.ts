/**
 * Create/promote shell cleanup: a failed push deletes the just-created repo
 * only when it is confirmed empty. A push that was accepted before failing
 * must keep its commits, and an unverifiable state fails safe (keep).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/session", () => ({
  AppSession: class MockAppSession {},
}));

import worker from "../src/index";
import type { Env } from "../src/index";

afterEach(() => {
  vi.unstubAllGlobals();
});

function testEnv(stub: unknown): Env {
  return {
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    APP: { idFromName: (n: string) => n, get: () => stub },
  } as unknown as Env;
}

const call = (path: string, env: Env, init?: RequestInit) =>
  worker.fetch(new Request(`https://app.test${path}`, init), env);
const post = (path: string, env: Env, body: unknown) =>
  call(path, env, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function stubFor(opts: { pushError: string; linked?: { owner: string; repo: string; branch: string } | null }) {
  return {
    getGitHubToken: async () => "gho_t",
    getGitHubStatus: async () => ({
      connected: true,
      user: { login: "octo", id: 1 },
      linked: opts.linked ?? null,
      scopes: [],
      grantedScopes: [],
      tokenKind: "oauth",
    }),
    getFiles: async () => ({}),
    pushCurrentToRemote: async () => {
      throw new Error(opts.pushError);
    },
    promoteBranchToRepo: async () => {
      throw new Error(opts.pushError);
    },
  };
}

/** GitHub API double: createRepo POST, commits probe GET, deleteRepo DELETE. */
function mockGitHub(probe: "commits" | "empty" | "broken") {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: unknown, init?: RequestInit) => {
      const url = String(u);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.endsWith("/user/repos") && method === "POST") {
        return Response.json({
          full_name: "octo/r",
          name: "r",
          private: false,
          default_branch: "main",
          html_url: "https://github.com/octo/r",
          owner: { login: "octo" },
        });
      }
      if (url.includes("/commits?per_page=1")) {
        if (probe === "commits") return Response.json([{ sha: "abc" }]);
        if (probe === "empty") return new Response("Git Repository is EMPTY", { status: 409 });
        return new Response("denied", { status: 403 });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      throw new Error("unexpected fetch " + method + " " + url);
    }),
  );
  return calls;
}

describe("create/promote shell cleanup", () => {
  it("keeps a repo that may already contain pushed commits", async () => {
    const env = testEnv(stubFor({ pushError: "connection reset" }));
    const calls = mockGitHub("commits");
    const res = await post("/api/github/create", env, { name: "r" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/may already contain pushed commits/);
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("deletes a confirmed-empty shell so retrying is safe", async () => {
    const env = testEnv(stubFor({ pushError: "connection reset" }));
    const calls = mockGitHub("empty");
    const res = await post("/api/github/create", env, { name: "r" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/retrying is safe/);
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(true);
  });

  it("keeps the repo when the probe itself fails", async () => {
    const env = testEnv(stubFor({ pushError: "connection reset" }));
    const calls = mockGitHub("broken");
    const res = await post("/api/github/create", env, { name: "r" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/could not be verified/);
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("applies the same rule on the promote path", async () => {
    const env = testEnv(stubFor({ pushError: "connection reset", linked: { owner: "o", repo: "old", branch: "proto/x" } }));
    const calls = mockGitHub("commits");
    const res = await post("/api/github/promote", env, { name: "r" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/may already contain pushed commits/);
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });
});
