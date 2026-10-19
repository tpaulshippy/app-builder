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
  turnActive?: boolean;
}) {
  let current = opts.linked ?? null;
  let currentFiles = { "server/index.ts": "live" };
  const chats: Chat[] = [];
  const calls: { cloned: unknown[]; cleared: number; built: number; unlinked: number; snapshots: unknown[] } = { cloned: [], cleared: 0, built: 0, unlinked: 0, snapshots: [] };
  const stub = {
    getGitHubToken: async () => opts.token,
    isTurnActive: async () => opts.turnActive ?? false,
    unlinkRepo: async () => {
      calls.unlinked++;
      current = null;
    },
    getGitHubStatus: async () => ({
      connected: Boolean(opts.token),
      user: null,
      linked: current,
      scopes: [],
      grantedScopes: [],
      tokenKind: "oauth",
    }),
    getFiles: async () => ({ ...currentFiles }),
    getMessages: async () => [],
    build: async () => {
      calls.built++;
      return { ok: true, files: { "server/index.ts": "live" }, diagnostics: [] };
    },
    clearChat: async () => {
      calls.cleared++;
    },
    cloneFromGitHub: async (args: { owner: string; repo: string; branch?: string }) => {
      if (opts.failClone) throw new Error(opts.failClone);
      calls.cloned.push(args);
      // Model the production state change: the clone links the new repo and
      // replaces the worktree files, so a stale fixture cannot pass.
      current = { owner: args.owner, repo: args.repo, branch: args.branch ?? "main" };
      currentFiles = { "server/index.ts": `cloned:${args.repo}` };
      return { files: { ...currentFiles }, meta: { ...current }, skipped: [], output: "ok", kept: 0 };
    },
    listChats: async () => chats.map(({ messages: _m, files: _f, ...meta }) => meta),
    snapshotChat: async (title?: string) => {
      calls.snapshots.push(title);
      const meta = { ...snapshotMeta(`s${chats.length + 1}`, [{ role: "user" as const, content: "hi" }], { "server/index.ts": "live" }, title, 1, current), id: `snap-${String(chats.length + 1).padStart(4, "0")}` };
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
        linked: current,
        repoNote: repoNoteFor(repo, current),
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
    /** Simulate linking a different repo (logout/open) between calls. */
    relink: (next: { owner: string; repo: string; branch: string } | null) => {
      current = next;
    },
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

  it("resume reports a repo mismatch note through the real stub flow", async () => {
    const f = testEnv({ token: "gho_t", linked: { owner: "o", repo: "r", branch: "main" } });
    await post("/api/chats/snapshot", f.env, { title: "W" });
    // Relink to a different repo before resuming.
    f.relink({ owner: "o", repo: "other", branch: "main" });
    const res = await post(`/api/chats/${f.chats[0]?.id}/resume`, f.env, {});
    const body = (await res.json()) as { repoNote: string; repo: unknown; linked: unknown };
    expect(res.status).toBe(200);
    expect(body.repoNote).toMatch(/mismatch/);
    expect(body.repo).toEqual({ owner: "o", repo: "r", branch: "main" });
    expect(body.linked).toEqual({ owner: "o", repo: "other", branch: "main" });
  });

  it("start-with-repo clones a different repo and reports its exact files and link", async () => {
    const { env, stub } = testEnv({ token: "gho_t", linked: { owner: "o", repo: "r", branch: "main" } });
    const res = await post("/api/chats/start", env, { repoRef: "o/other", branch: "dev" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: unknown; built: unknown; linked: unknown };
    // Exact post-clone state, not truthiness: a fixture that never applies
    // the clone must fail here.
    expect(body.files).toEqual({ "server/index.ts": "cloned:other" });
    expect(body.linked).toEqual({ owner: "o", repo: "other", branch: "dev" });
    expect(body.built).toBeTruthy();
    expect(stub.__calls.cloned).toEqual([{ owner: "o", repo: "other", branch: "dev" }]);
    expect(stub.__calls.cleared).toBe(1);
  });

  it("start without a repo unlinks so the fresh chat is repo-less", async () => {
    const f = testEnv({ token: "gho_t", linked: { owner: "o", repo: "r", branch: "main" } });
    const res = await post("/api/chats/start", f.env, {});
    expect(res.status).toBe(200);
    expect(f.stub.__calls.unlinked).toBe(1);
    expect(f.stub.__calls.cloned).toHaveLength(0);
    expect(f.stub.__calls.cleared).toBe(1);
    expect(((await res.json()) as { linked: unknown }).linked).toBeNull();
    // A snapshot taken afterwards records no repo.
    const snap = await post("/api/chats/snapshot", f.env, { title: "after" });
    expect(((await snap.json()) as { chat: Chat }).chat.repo).toBeNull();
  });

  it("start rejects with 409 while an agent turn is active", async () => {
    const { env, stub } = testEnv({ token: "gho_t", linked: null, turnActive: true });
    const res = await post("/api/chats/start", env, { repoRef: "o/r" });
    expect(res.status).toBe(409);
    expect(stub.__calls.cloned).toHaveLength(0);
    expect(stub.__calls.cleared).toBe(0);
  });

  it("start snapshots the current chat first when a title is given", async () => {
    const { env, stub } = testEnv({ token: "gho_t", linked: null });
    const res = await post("/api/chats/start", env, { title: "checkpoint" });
    expect(res.status).toBe(200);
    expect(stub.__calls.snapshots).toEqual(["checkpoint"]);
  });

  it("start maps an oversized pre-snapshot to 413", async () => {
    const { env, stub } = testEnv({ token: "gho_t", linked: null });
    stub.snapshotChat = async () => {
      throw new Error("chat snapshot too large (1.6 MB): remove files or clear the chat before saving");
    };
    const res = await post("/api/chats/start", env, { title: "checkpoint" });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/too large/);
    expect(stub.__calls.cleared).toBe(0);
  });

  it("start treats a JSON null body as an empty fresh-chat request", async () => {
    const { env, stub } = testEnv({ token: "gho_t", linked: null });
    const res = await call("/api/chats/start", env, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(200);
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
    expect(client).toContain("save current as");
  });
});

describe("repoNoteFor", () => {
  const main = { owner: "o", repo: "r", branch: "main" };
  const dev = { owner: "o", repo: "r", branch: "dev" };

  it("reports the link when snapshot and session agree", () => {
    expect(repoNoteFor(main, { ...main })).toBe("linked to o/r@main");
    expect(repoNoteFor(null, null)).toBe("no repo linked");
  });

  it("warns on repo and branch mismatches", () => {
    expect(repoNoteFor(main, dev)).toMatch(/mismatch/);
    expect(repoNoteFor(dev, main)).toMatch(/mismatch/);
    expect(repoNoteFor(main, { owner: "o", repo: "other", branch: "main" })).toMatch(/mismatch/);
    expect(repoNoteFor(main, null)).toMatch(/no repo linked now/);
    expect(repoNoteFor(null, main)).toMatch(/no linked repo/);
  });
});
