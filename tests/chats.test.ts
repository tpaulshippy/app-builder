/**
 * Session history: named checkpoints of chat + files behind the GitHub login
 * gate. The real Durable Object module (Pi/WASM) cannot load under vitest
 * (cloudflare:workers), so the Worker is driven with an in-memory stub DO —
 * the same pattern as tests/auth.test.ts — while the snapshot metadata
 * helpers (the real logic in src/chats.ts) are unit-tested directly.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/session", () => ({
  AppSession: class MockAppSession {},
}));

import worker from "../src/index";
import type { Env } from "../src/index";
import {
  capChatList,
  capMessages,
  checkSnapshotSize,
  firstUserPreview,
  shouldAutoSnapshot,
  snapshotMeta,
} from "../src/chats";

type LiveState = {
  messages: Array<{ role: string; content: string }>;
  files: Record<string, string>;
};

type Chat = {
  id: string;
  title: string;
  createdAt: number;
  messageCount: number;
  preview: string;
  messages?: Array<{ role: string; content: string }>;
  files?: Record<string, string>;
};

function testEnv(token: string | null, store?: { chats: Chat[]; live?: LiveState; failSnapshot?: string; failResume?: string }) {
  const live: LiveState = store?.live ?? {
    messages: [
      { role: "user", content: "build me a clock" },
      { role: "assistant", content: "done" },
    ],
    files: { "server/index.ts": "live content" },
  };
  const chats: Chat[] = store?.chats ?? [];
  if (store) {
    store.chats = chats;
    store.live = live;
  }
  const stub = {
    getGitHubToken: async () => token,
    getFiles: async () => ({}),
    getMessages: async () => [],
    build: async () => ({ ok: true, files: {}, diagnostics: [] }),
    listChats: async () =>
      chats.map(({ messages: _m, files: _f, ...meta }) => meta),
    snapshotChat: async (title?: string) => {
      if (store?.failSnapshot) throw new Error(store.failSnapshot);
      const meta = {
        id: `snap-${String(chats.length + 1).padStart(4, "0")}`,
        title: title || "untitled",
        createdAt: Date.now(),
        messageCount: live.messages.length,
        preview: live.messages[0]?.content ?? "",
      };
      chats.unshift({ ...meta, messages: [...live.messages], files: { ...live.files } });
      return meta;
    },
    resumeChat: async (id: string) => {
      if (store?.failResume) throw new Error(store.failResume);
      const found = chats.find((c) => c.id === id);
      if (!found) throw new Error("chat snapshot not found");
      return {
        messages: found.messages ?? [],
        files: found.files ?? {},
        built: { ok: true, files: found.files ?? {}, diagnostics: [] },
      };
    },
    renameChat: async (id: string, title: string) => {
      const clean = title.trim();
      if (!clean) throw new Error("snapshot title is required");
      const found = chats.find((c) => c.id === id);
      if (!found) throw new Error("chat snapshot not found");
      found.title = clean;
      const { messages: _m, files: _f, ...meta } = found;
      return meta;
    },
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

describe("session history gate", () => {
  it("rejects list/snapshot/resume when anonymous", async () => {
    const env = testEnv(null);
    const list = await call("/api/chats", env);
    expect(list.status).toBe(401);
    expect(await list.json()).toEqual({ error: "github login required" });
    const snap = await post("/api/chats/snapshot", env, { title: "x" });
    expect(snap.status).toBe(401);
    expect(await snap.json()).toEqual({ error: "github login required" });
    const resume = await post("/api/chats/snap-0001/resume", env, {});
    expect(resume.status).toBe(401);
    expect(await resume.json()).toEqual({ error: "github login required" });
    const rename = await post("/api/chats/snap-0001/rename", env, { title: "x" });
    expect(rename.status).toBe(401);
    expect(await rename.json()).toEqual({ error: "github login required" });
  });

  it("lists snapshots newest-first for an authenticated session", async () => {
    const store: { chats: Chat[] } = { chats: [] };
    const env = testEnv("gho_test", store);
    await post("/api/chats/snapshot", env, { title: "First" });
    await post("/api/chats/snapshot", env, { title: "Second" });
    const res = await call("/api/chats", env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chats: Chat[] };
    expect(body.chats.map((c) => c.title)).toEqual(["Second", "First"]);
    expect(body.chats[0]).toMatchObject({ messageCount: 2 });
    // Metadata only: messages/files stay server-side until resume.
    expect(body.chats[0]).not.toHaveProperty("messages");
    expect(body.chats[0]).not.toHaveProperty("files");
  });

  it("snapshots and resumes round-trip messages + files", async () => {
    const store: { chats: Chat[] } = { chats: [] };
    const env = testEnv("gho_test", store);
    const snap = await post("/api/chats/snapshot", env, { title: "Work" });
    expect(snap.status).toBe(200);
    expect(((await snap.json()) as { chat: Chat }).chat).toMatchObject({ title: "Work" });

    const list = await call("/api/chats", env);
    expect(((await list.json()) as { chats: Chat[] }).chats).toHaveLength(1);

    const resume = await post(
      `/api/chats/${store.chats[0]?.id}/resume`,
      env,
      {},
    );
    expect(resume.status).toBe(200);
    const body = (await resume.json()) as { messages: unknown; files: unknown; built: unknown };
    expect(body).toHaveProperty("messages");
    expect(body).toHaveProperty("files");
    expect(body).toHaveProperty("built");
    // Exact round-trip of the live state the snapshot captured.
    expect(body.messages).toEqual([
      { role: "user", content: "build me a clock" },
      { role: "assistant", content: "done" },
    ]);
    expect(body.files).toEqual({ "server/index.ts": "live content" });
  });

  it("returns 404 for an unknown snapshot id", async () => {
    const res = await post("/api/chats/does-not-exist-1/resume", testEnv("gho_test"), {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "chat snapshot not found" });
  });

  it("returns 500 (not 404) when resume fails server-side", async () => {
    const env = testEnv("gho_test", { chats: [], failResume: "pi blew up" });
    const res = await post("/api/chats/snap-0001/resume", env, {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "pi blew up" });
  });

  it("renames a snapshot and the list reflects it", async () => {
    const store: { chats: Chat[] } = { chats: [] };
    const env = testEnv("gho_test", store);
    await post("/api/chats/snapshot", env, { title: "Old" });
    const id = store.chats[0]?.id ?? "";
    const renamed = await post(`/api/chats/${id}/rename`, env, { title: "  New  " });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { chat: Chat }).chat).toMatchObject({ id, title: "New" });
    const list = await call("/api/chats", env);
    expect(((await list.json()) as { chats: Chat[] }).chats[0]?.title).toBe("New");
  });

  it("rejects rename with 404 for unknown ids and 400 for empty titles", async () => {
    const env = testEnv("gho_test", { chats: [] });
    const missing = await post("/api/chats/snap-9999/rename", env, { title: "x" });
    expect(missing.status).toBe(404);
    await post("/api/chats/snapshot", env, { title: "Old" });
    const id = "snap-0001";
    for (const body of [{ title: "" }, { title: "   " }, {}]) {
      const res = await post(`/api/chats/${id}/rename`, env, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "snapshot title is required" });
    }
  });

  it("returns 413 when a snapshot would exceed the storage value cap", async () => {
    const env = testEnv("gho_test", {
      chats: [],
      failSnapshot: "chat snapshot too large (3.0 MB): remove files or clear the chat before saving",
    });
    const res = await post("/api/chats/snapshot", env, { title: "big" });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "chat snapshot too large (3.0 MB): remove files or clear the chat before saving",
    });
  });

  it("drives history through the shared 401 handler", async () => {
    const html = await (await call("/", testEnv(null))).text();
    expect(html).toContain('id="historybtn"');
    expect(html).toContain('id="history"');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const client = scripts[scripts.length - 1] ?? "";
    expect(client).toContain('apiFetch("/api/chats"');
    expect(client).toContain('apiFetch("/api/chats/snapshot"');
    expect(client).toContain('"/resume"');
    expect(client).toContain('"/rename"');
    // The Code-tab snapshot control is JS-rendered; its CSS ships statically.
    expect(html).toContain("#snapname");
  });
});

describe("snapshot metadata", () => {
  const msgs = [
    { role: "user" as const, content: "  build me a clock  " },
    { role: "assistant" as const, content: "done" },
  ];

  it("prefers an explicit title, falling back to preview then timestamp", () => {
    expect(snapshotMeta("a", msgs, {}, "My title", 1700000000000).title).toBe("My title");
    expect(snapshotMeta("a", msgs, {}, "", 1700000000000).title).toBe("build me a clock");
    expect(snapshotMeta("a", msgs, {}, "  ", 1700000000000).title).toBe("build me a clock");
    expect(snapshotMeta("a", [], {}, undefined, 1700000000000).title).toContain("Chat ");
  });

  it("truncates the preview and counts messages", () => {
    const long = "x".repeat(500);
    const meta = snapshotMeta("a", [{ role: "user" as const, content: long }], {}, undefined, 1);
    expect(meta.preview).toHaveLength(120);
    expect(meta.messageCount).toBe(1);
    expect(meta.title).toHaveLength(60);
  });

  it("names auto-checkpoints from the first prompt", () => {
    expect(firstUserPreview(msgs)).toBe("build me a clock");
    expect(firstUserPreview([])).toBe("");
    expect(firstUserPreview([{ role: "assistant" as const, content: "hi" }])).toBe("");
  });

  it("auto-snapshots settled turns but never empties or duplicates", () => {
    const files = { "server/index.ts": "v1" };
    const newest = snapshotMeta("s1", msgs, files, undefined, 1);
    expect(newest.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    // Empty transcript: nothing to keep.
    expect(shouldAutoSnapshot(newest, [], files)).toBe(false);
    expect(shouldAutoSnapshot(undefined, [], files)).toBe(false);
    // First turn ever: keep it.
    expect(shouldAutoSnapshot(undefined, msgs, files)).toBe(true);
    // Unchanged since the newest checkpoint (e.g. idle New-chat click): skip.
    expect(shouldAutoSnapshot(newest, msgs, files)).toBe(false);
    // New reply since the checkpoint: keep it.
    expect(shouldAutoSnapshot(newest, [...msgs, { role: "user" as const, content: "again" }], files)).toBe(true);
  });

  it("fingerprints the full transcript and files, not the truncated preview", () => {
    const files = { "server/index.ts": "v1" };
    const newest = snapshotMeta("s1", msgs, files, undefined, 1);
    const sameOpening = [
      { role: "user" as const, content: "build me a clock" },
      // Same count, same first 120 chars, different second turn.
      { role: "assistant" as const, content: "a completely different answer" },
    ];
    expect(shouldAutoSnapshot(newest, sameOpening, files)).toBe(true);
    // Editor-only change with an identical transcript still checkpoints.
    expect(shouldAutoSnapshot(newest, msgs, { "server/index.ts": "v2" })).toBe(true);
    // Entries written before fingerprints mismatch safely (checkpoint again).
    const { fingerprint: _fp, ...legacy } = newest;
    expect(shouldAutoSnapshot(legacy, msgs, files)).toBe(true);
  });

  it("rejects snapshots that would exceed one storage value", () => {
    expect(() => checkSnapshotSize([], {}, 100)).not.toThrow();
    expect(() => checkSnapshotSize([{ role: "user", content: "x".repeat(100) }], {}, 10)).toThrow(
      /chat snapshot too large/,
    );
  });

  it("caps the list newest-first and reports evicted ids", () => {
    const prev = [1, 2, 3].map((n) => ({
      id: `s${n}`,
      title: `t${n}`,
      createdAt: n,
      messageCount: n,
      preview: "",
      fingerprint: `fp${n}`,
    }));
    const meta = snapshotMeta("new", [], {}, "New", 9);
    const { chats, evicted } = capChatList(prev, meta, 3);
    expect(chats.map((c) => c.id)).toEqual(["new", "s1", "s2"]);
    expect(evicted).toEqual(["s3"]);
  });

  it("caps snapshots to the same window the live session keeps", () => {
    const long = Array.from({ length: 65 }, (_, i) => ({ role: "user" as const, content: `m${i}` }));
    expect(capMessages(long)).toHaveLength(60);
    expect(capMessages(long)[0]).toEqual({ role: "user", content: "m5" });
    expect(capMessages(msgs)).toEqual(msgs);
  });
});
