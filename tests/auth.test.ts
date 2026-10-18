/**
 * GitHub login gate: anonymous visitors get 401 {error:"github login required"}
 * on every app API, while the OAuth round-trip, the status probe, and the
 * page itself stay public. The page serves a full-page login gate for them.
 *
 * The heavy Durable Object module (Pi/WASM) is mocked out: these tests drive
 * the Worker's real fetch handler with a stub DO whose only login signal is
 * getGitHubToken(), exactly what the gate checks.
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
      user: null,
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

const post = (path: string, env: Env, body: unknown) =>
  call(path, env, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("github login gate", () => {
  it("rejects unauthenticated /api/state with 401", async () => {
    const res = await call("/api/state", testEnv(null));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "github login required" });
  });

  it("lets an authenticated session load /api/state", async () => {
    const res = await call("/api/state", testEnv("gho_test"));
    expect(res.status).toBe(200);
  });

  it("rejects unauthenticated /api/chat even with an API key (login first)", async () => {
    const res = await post("/api/chat", testEnv(null), { message: "hi" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "github login required" });
  });

  it("lets an authenticated session with a key reach the agent", async () => {
    const res = await call("/api/chat", testEnv("gho_test"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-provider-key": "k" },
      body: JSON.stringify({ message: "hi", gateway: "zen", model: "muse-spark-1.3" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("still asks an authenticated session for its API key", async () => {
    const res = await post("/api/chat", testEnv("gho_test"), { message: "hi" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "no API key — enter one below (stored only in this browser)",
    });
  });

  it("rejects every other app API when anonymous", async () => {
    const env = testEnv(null);
    const cases: Array<[string, Promise<Response>]> = [
      ["/api/build", post("/api/build", env, {})],
      ["/api/file", post("/api/file", env, { path: "a.ts", content: "x" })],
      ["/api/files", post("/api/files", env, { files: {} })],
      ["/api/reset", post("/api/reset", env, {})],
      ["/api/clear-chat", post("/api/clear-chat", env, {})],
      ["/api/git/commit", post("/api/git/commit", env, { message: "m" })],
      ["/api/git/pull", post("/api/git/pull", env, {})],
      ["/api/git/status", call("/api/git/status", env)],
      ["/api/git/log", call("/api/git/log", env)],
      ["/api/git/run", post("/api/git/run", env, { command: "git status" })],
      ["/api/github/repos", call("/api/github/repos", env)],
      ["/api/github/create", post("/api/github/create", env, { name: "r" })],
      ["/api/github/open", post("/api/github/open", env, { ref: "o/r" })],
      ["/api/github/logout", post("/api/github/logout", env, {})],
    ];
    for (const [path, pending] of cases) {
      const res = await pending;
      expect(res.status, path).toBe(401);
      expect(await res.json(), path).toEqual({ error: "github login required" });
    }
  });

  it("rejects the sid-selected app endpoints and the Pi probe when anonymous", async () => {
    const env = testEnv(null);
    const sid = "testsid123456";
    const state = await call(`/api/app-state?sid=${sid}`, env);
    expect(state.status).toBe(401);
    expect(await state.json()).toEqual({
      ok: false,
      error: { name: "Auth", message: "github login required" },
    });
    const mutate = await post(`/api/app-mutate`, env, { sid, kind: "mutation", name: "m", args: [] });
    expect(mutate.status).toBe(401);
    expect(await mutate.json()).toEqual({
      ok: false,
      error: { name: "Auth", message: "github login required" },
    });
    const app = await call(`/api/app?sid=${sid}`, env);
    expect(app.status).toBe(401);
    const probe = await call("/api/pi-harness-status", env);
    expect(probe.status).toBe(401);
    expect(await probe.json()).toEqual({ error: "github login required" });
  });

  it("lets an authenticated session reach the app endpoints and the Pi probe", async () => {
    const env = testEnv("gho_test");
    const sid = "testsid123456";
    expect((await call(`/api/app-state?sid=${sid}`, env)).status).toBe(200);
    expect((await call("/api/pi-harness-status", env)).status).toBe(200);
  });

  it("routes every app-API call through the shared 401 handler", async () => {
    const html = await (await call("/", testEnv(null))).text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const client = scripts[scripts.length - 1] ?? "";
    expect(client).toContain("async function apiFetch(url, init)");
    for (const path of [
      "/api/state",
      "/api/chat",
      "/api/file",
      "/api/files",
      "/api/clear-chat",
      "/api/github/repos",
      "/api/github/open",
      "/api/github/create",
      "/api/github/logout",
      "/api/git/commit",
      "/api/git/pull",
      "/api/git/run",
      "/api/app-state",
    ]) {
      expect(client, path).toContain(`apiFetch("${path}`);
    }
    // The dynamic git status/log reader goes through it too.
    expect(client).toContain('apiFetch("/api/git/" + which');
    // The public status probe stays a raw fetch.
    expect(client).toContain('fetch("/api/github/status"');
  });

  it("keeps the login flow, the status probe, and the page public", async () => {
    const env = testEnv(null);
    expect((await call("/api/github/status", env)).status).toBe(200);
    const login = await call("/api/github/login", env);
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toContain("github.com/login/oauth/authorize");
    const page = await call("/", env);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
  });

  it("gives the sandboxed preview an auth-expiry channel to the parent", async () => {
    // Source-shape pin for the parent wiring (no DOM runner in this repo):
    // the expiry contract itself is driven behaviorally below.
    const html = await (await call("/", testEnv(null))).text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const client = scripts[scripts.length - 1] ?? "";
    expect(client).toContain("function showGate()");
    // Parent: tracks the mounted frame and source-checks the expiry message.
    expect(client).toContain("app-builder:auth-required");
    expect(client).toContain("e.source !== appFrameEl.contentWindow");
    expect(client).toContain("if (authed) showGate();");
    // The gate unmounts the frame so its shim stops polling; tracking ends
    // exactly where the frame is removed.
    const gate = client.match(/function showGate\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(gate).toContain("authed = false");
    expect(gate).toContain('pane.innerHTML = ""');
    // Mount-time probe through the shared handler (an iframe 401 is silent).
    expect(client).toContain('apiFetch("/api/app-state?sid="');
    // Shim: reports a login-required 401 up from state and mutate paths.
    const shim = await (await call("/api/app-shim.js", testEnv(null))).text();
    expect(shim).toContain('parent.postMessage("app-builder:auth-required", "*")');
    expect(shim).toContain("noteAuth(res, body)");
  });

  it("reports a login-required 401 from the shipped shim to the parent", async () => {
    const shim = await (await call("/api/app-shim.js", testEnv(null))).text();
    const src = shim.match(/function noteAuth\(res, body\) \{[\s\S]*?\n\}/)?.[0];
    expect(src, "noteAuth ships in the shim").toBeTruthy();
    const posted: Array<{ msg: unknown; target: unknown }> = [];
    const run = new Function(
      "parent",
      "res",
      "body",
      `${src}; noteAuth(res, body);`,
    ) as (parent: unknown, res: unknown, body: unknown) => void;
    const parent = {
      postMessage: (msg: unknown, target: unknown) => {
        posted.push({ msg, target });
      },
    };
    run(parent, { status: 401 }, { error: { message: "github login required" } });
    expect(posted).toEqual([{ msg: "app-builder:auth-required", target: "*" }]);
    posted.length = 0;
    run(parent, { status: 401 }, { error: { message: "something else" } });
    run(parent, { status: 200 }, { ok: true });
    run(parent, { status: 401 }, null);
    expect(posted).toEqual([]);
  });

  it("serves the full-page login gate to anonymous visitors", async () => {
    const html = await (await call("/", testEnv(null))).text();
    expect(html).toContain('id="gate"');
    expect(html).toContain("Log in with GitHub");
    expect(html).toContain('id="loginbtn"');
  });
});
