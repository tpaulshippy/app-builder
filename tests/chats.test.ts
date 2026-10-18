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
import { capChatList, snapshotMeta } from "../src/chats";

type Chat = {
  id: string;
  title: string;
  createdAt: number;
  messageCount: number;
  preview: string;
  messages?: Array<{ role: string; content: string }>;
  files?: Record<string, string>;
};

function testEnv(token: string | null, store?: { chats: Chat[] }) {
  const chats: Chat[] = store?.chats ?? [
    {
      id: "snap-0001",
      title: "First",
      createdAt: 1700000000000,
      messageCount: 2,
      preview: "hello",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      files: { "server/index.ts": "x" },
    },
  ];
  if (store) store.chats = chats;
  const stub = {
    getGitHubToken: async () => token,
    getFiles: async () => ({}),
    getMessages: async () => [],
    build: async () => ({ ok: true, files: {}, diagnostics: [] }),
    listChats: async () =>
      chats.map(({ messages: _m, files: _f, ...meta }) => meta),
    snapshotChat: async (title?: string) => {
      const meta = {
        id: `snap-${String(chats.length + 1).padStart(4, "0")}`,
        title: title || "untitled",
        createdAt: Date.now(),
        messageCount: 1,
        preview: "p",
      };
      chats.unshift({ ...meta, messages: [], files: {} });
      return meta;
    },
    resumeChat: async (id: string) => {
      const found = chats.find((c) => c.id === id);
      if (!found) throw new Error("chat snapshot not found");
      return { messages: found.messages ?? [], files: found.files ?? {} };
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
  });

  it("lists snapshots newest-first for an authenticated session", async () => {
    const res = await call("/api/chats", testEnv("gho_test"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chats: Chat[] };
    expect(body.chats).toHaveLength(1);
    expect(body.chats[0]).toMatchObject({ id: "snap-0001", title: "First", messageCount: 2 });
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
  });

  it("returns 404 for an unknown snapshot id", async () => {
    const res = await post("/api/chats/does-not-exist-1/resume", testEnv("gho_test"), {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "chat snapshot not found" });
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
  });
});

describe("snapshot metadata", () => {
  const msgs = [
    { role: "user" as const, content: "  build me a clock  " },
    { role: "assistant" as const, content: "done" },
  ];

  it("prefers an explicit title, falling back to preview then timestamp", () => {
    expect(snapshotMeta("a", msgs, "My title", 1700000000000).title).toBe("My title");
    expect(snapshotMeta("a", msgs, "", 1700000000000).title).toBe("build me a clock");
    expect(snapshotMeta("a", msgs, "  ", 1700000000000).title).toBe("build me a clock");
    expect(snapshotMeta("a", [], undefined, 1700000000000).title).toContain("Chat ");
  });

  it("truncates the preview and counts messages", () => {
    const long = "x".repeat(500);
    const meta = snapshotMeta("a", [{ role: "user" as const, content: long }], undefined, 1);
    expect(meta.preview).toHaveLength(120);
    expect(meta.messageCount).toBe(1);
    expect(meta.title).toHaveLength(60);
  });

  it("caps the list newest-first and reports evicted ids", () => {
    const prev = [1, 2, 3].map((n) => ({
      id: `s${n}`,
      title: `t${n}`,
      createdAt: n,
      messageCount: n,
      preview: "",
    }));
    const meta = snapshotMeta("new", [], "New", 9);
    const { chats, evicted } = capChatList(prev, meta, 3);
    expect(chats.map((c) => c.id)).toEqual(["new", "s1", "s2"]);
    expect(evicted).toEqual(["s3"]);
  });
});
