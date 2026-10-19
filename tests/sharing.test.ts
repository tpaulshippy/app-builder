/**
 * Issue #30: shared live sessions have no safe path, so v1 documents the
 * threat model and offers no session-id sharing affordance.
 *
 * - The page/Settings panel warns that ab_session / ?sid= is a password
 *   (full access + push-as-owner) and points at the safe primitives:
 *   deploy URL (view) and GitHub repo (co-edit).
 * - No "share session / copy share link" affordance exists.
 * - No share/team/publish API exists (nothing to write into another DO).
 * - Every write path still addresses only the caller's own session object.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/session", () => ({
  AppSession: class MockAppSession {},
}));

import worker from "../src/index";
import type { Env } from "../src/index";

function testEnv(token: string | null): Env {
  const stub = {
    getGitHubToken: async () => token,
    getGitHubStatus: async () => ({
      connected: Boolean(token),
      user: token ? { login: "ada" } : null,
      linked: null,
      scopes: [],
      grantedScopes: [],
      tokenKind: token ? "oauth" : "missing",
    }),
    getFiles: async () => ({}),
    getMessages: async () => [],
    build: async () => ({ ok: true, files: {}, diagnostics: [] }),
    appState: async () => ({ ok: true, tables: [], queries: {} }),
    appMutate: async () => ({ ok: true }),
    fetch: async () =>
      new Response(`data: ${JSON.stringify({ type: "done", messages: [], files: {} })}\n\n`, {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      }),
  };
  return {
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    APP: { idFromName: (name: string) => name, get: () => stub },
  } as unknown as Env;
}

const call = (path: string, env: Env, init?: RequestInit) =>
  worker.fetch(new Request(`https://app.test${path}`, init), env);

function pageClient(html: string): string {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  return scripts[scripts.length - 1] ?? "";
}

describe("issue #30 sharing threat model", () => {
  it("warns in-product that the session id is not a share link", async () => {
    const html = await (await call("/", testEnv(null))).text();
    const client = pageClient(html);
    expect(client).toContain("There is no shared live session");
    expect(client).toContain("Never share your session cookie");
    expect(client).toContain("?sid=");
    expect(client).toContain("push-as-owner");
    expect(client).toContain("lakebed URL");
    expect(client).toContain("GitHub repo");
  });

  it("offers no voluntary session-id sharing affordance", async () => {
    const html = await (await call("/", testEnv(null))).text();
    const client = pageClient(html);
    const lowered = (html + "\n" + client).toLowerCase();
    expect(lowered).not.toContain("copy share link");
    expect(lowered).not.toContain("share session");
    expect(lowered).not.toContain("copy session link");
    expect(lowered).not.toContain("share my session");
    expect(lowered).not.toContain("invite collaborator");
  });

  it("has no share/team/publish API (no cross-DO write path)", async () => {
    const env = testEnv("gho_test");
    for (const path of [
      "/api/share",
      "/api/teams",
      "/api/publish",
      "/api/remix",
      "/api/playgrounds/share",
    ]) {
      const get = await call(path, env);
      expect(get.status, `GET ${path}`).toBe(404);
      const post = await call(path, env, { method: "POST" });
      expect(post.status, `POST ${path}`).toBe(404);
    }
  });

  it("keeps the sid-selected app endpoints behind the owning object's token", async () => {
    const anon = testEnv(null);
    const sid = "testsid123456";
    expect((await call(`/api/app-state?sid=${sid}`, anon)).status).toBe(401);
    expect((await call(`/api/app?sid=${sid}`, anon)).status).toBe(401);
  });
});
