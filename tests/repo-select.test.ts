/**
 * Repo selection per chat session (#10): snapshots carry the linked repo,
 * GET /api/chats reports the current link, POST /api/chats/start optionally
 * clones a repo then clears the agent context. All behind the #8 login gate.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/session", () => ({
  AppSession: class MockAppSession {},
}));

import worker from "../src/index";
import type { Env } from "../src/index";
import { repoNoteFor, snapshotMeta } from "../src/chats";

type Chat = {
  id: string;
  title: string;
  createdAt: number;
  messageCount: number;
  preview: string;
  repo?: { owner: string; repo: string; branch: string } | null;
  messages?: Array<{ role: string; content: string }>;
  files?: Record<string, string>;
};

function testEnv(opts: {
  token: string | null;
  linked?: { owner: string; repo: string; branch: string } | null;
  failClone?: string;
}) {
  const linked = opts.linked ?? null;
  const chats: Chat[] = [];
  const calls: { cloned: unknown[]; cleared: number; built: number } = { cloned: [], cleared: 0, built: 0 };
  const stub = {
    getGitHubToken: async () => opts.token,
    getGitHubStatus: async () => ({
      connected: Boolean(opts.token),
      user: null,
      linked,
      scopes: [],
      grantedScopes: [],
      tokenKind: "oauth",
    }),
    getFiles: async () => ({ "server/index.ts": "live" }),
    getMessages: async () => [],
    build: async () => {
      calls.built++;
      return { ok: true, files: { "server/index.ts": "live" }, diagnostics: [] };
    },
    clearChat: async () => {
      calls.cleared++;
    },
    cloneFromGitHub: async (args: unknown) => {
      if (opts.failClone) throw new Error(opts.failClone);
      calls.cloned.push(args);
      return { files: { "server/index.ts": "cloned" }, meta: { owner: "o", repo: "r", branch: "main" }, skipped: [], output: "ok", kept: 0 };
    },
    listChats: async () => chats.map(({ messages: _m, files: _f, ...meta }) => meta),
    snapshotChat: async (title?: string) => {
      const meta = { ...snapshotMeta(`s${chats.length + 1}`, [{ role: "user" as const, content: "hi" }], title, 1, linked), id: `snap-${String(chats.length + 1).padStart(4, "0")}` };
      chats.unshift({ ...meta, messages: [{ role: "user", content: "hi" }], files: { "server/index.ts": "live" } });
      return meta;
    },
    resumeChat: async (id: string) => {
      const found = chats.find((c) => c.id === id);
      if (!found) throw new Error("chat snapshot not found");
      const repo = found.repo ?? null;
      return {
        messages: found.messages ?? [],
        files: found.files ?? {},
        built: { ok: true, files: found.files ?? {}, diagnostics: [] },
        repo,
        linked,
        repoNote: repoNoteFor(repo, linked),
      };
    },
    __calls: calls,
  };
  return {
    env: {
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
      APP: { idFromName: (n: string) => n, get: () => stub },
    } as unknown as Env,
    stub,
    chats,
  };
}

const call = (path: string, env: Env, init?: RequestInit) =>
  worker.fetch(new Request(`https://app.test${path}`, init), env);

const post = (path: string, env: Env, body: unknown) =>
  call(path, env, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("repo selection per chat session", () => {
  it("snapshot carries the linked repo and the list reports it", async () => {
    const { env } = testEnv({ token: "gho_t", linked: { owner: "o", repo: "r", branch: "dev" } });
    const snap = await post("/api/chats/snapshot", env, { title: "W" });
    expect(snap.status).toBe(200);
    expect(((await snap.json()) as { chat: Chat }).chat.repo).toEqual({ owner: "o", repo: "r", branch: "dev" });
    const list = await call("/api/chats", env);
    const body = (await list.json()) as { chats: Chat[]; linked: unknown };
    expect(body.chats[0]?.repo).toEqual({ owner: "o", repo: "r", branch: "dev" });
    expect(body.linked).toEqual({ owner: "o", repo: "r", branch: "dev" });
    expect(body.chats[0]).not.toHaveProperty("messages");
  });

  it("snapshot records null repo when nothing is linked", async () => {
    const { env } = testEnv({ token: "gho_t", linked: null });
    const snap = await post("/api/chats/snapshot", env, { title: "W" });
    expect(((await snap.json()) as { chat: Chat }).chat.repo).toBeNull();
  });

  it("resume reports a repo mismatch note", async () => {
    const f = testEnv({ token: "gho_t", linked: { owner: "o", repo: "r", branch: "main" } });
    await post("/api/chats/snapshot", f.env, { title: "W" });
    // Relink to a different repo before resuming.
    const moved = testEnv({ token: "gho_t", linked: { owner: "o", repo: "other", branch: "main" } });
    (moved.stub as unknown as { listChats: unknown }).listChats = f.stub.listChats;
    (moved.stub as unknown as { resumeChat: unknown }).resumeChat = async (id: string) => {
      const found = f.chats.find((c) => c.id === id);
      if (!found) throw new Error("chat snapshot not found");
      const repo = found.repo ?? null;
      const linked = { owner: "o", repo: "other", branch: "main" };
      return {
        messages: found.messages ?? [], files: found.files ?? {},
        built: { ok: true, files: {}, diagnostics: [] }, repo, linked, repoNote: repoNoteFor(repo, linked),
      };
    };
    const res = await post(`/api/chats/${f.chats[0]?.id}/resume`, moved.env, {});
    const body = (await res.json()) as { repoNote: string; repo: unknown; linked: unknown };
    expect(res.status).toBe(200);
    expect(body.repoNote).toMatch(/mismatch/);
    expect(body.repo).toEqual({ owner: "o", repo: "r", branch: "main" });
    expect(body.linked).toEqual({ owner: "o", repo: "other", branch: "main" });
  });

  it("start-with-repo clones then clears the chat", async () => {
    const { env, stub } = testEnv({ token: "gho_t", linked: { owner: "o", repo: "r", branch: "main" } });
    const res = await post("/api/chats/start", env, { repoRef: "o/r", branch: "main" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: unknown; built: unknown; linked: unknown };
    expect(body.files).toBeTruthy();
    expect(body.built).toBeTruthy();
    expect(body.linked).toEqual({ owner: "o", repo: "r", branch: "main" });
    expect((stub.__calls.cloned as unknown[])).toHaveLength(1);
    expect(stub.__calls.cleared).toBe(1);
  });

  it("start without a repo just clears the chat", async () => {
    const { env, stub } = testEnv({ token: "gho_t", linked: null });
    const res = await post("/api/chats/start", env, {});
    expect(res.status).toBe(200);
    expect((stub.__calls.cloned as unknown[])).toHaveLength(0);
    expect(stub.__calls.cleared).toBe(1);
  });

  it("start rejects a bad repo ref with 500", async () => {
    const { env } = testEnv({ token: "gho_t" });
    const res = await post("/api/chats/start", env, { repoRef: "not-a-ref!!" });
    expect(res.status).toBe(500);
  });

  it("401s all repo-selection endpoints when anonymous", async () => {
    const { env } = testEnv({ token: null });
    for (const r of [
      await post("/api/chats/start", env, { repoRef: "o/r" }),
      await post("/api/chats/start", env, {}),
      await call("/api/chats", env),
    ]) {
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "github login required" });
    }
  });

  it("drives start + repo badges through the shared 401 handler", async () => {
    const { env } = testEnv({ token: null });
    const html = await (await call("/", env)).text();
    expect(html).toContain('id="repobadge"');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const client = scripts[scripts.length - 1] ?? "";
    expect(client).toContain('apiFetch("/api/chats/start"');
    expect(client).toContain("updateRepoBadge");
    expect(client).toContain("Started a fresh chat");
    expect(client).toContain("repoNote");
  });
});
