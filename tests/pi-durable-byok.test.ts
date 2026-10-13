/**
 * Slice (a) evidence: BYOK injection into Pi-owned generations.
 *
 * These tests drive a real Pi Durable `Harness` (MemoryStorage, no tools)
 * against a mocked OpenCode endpoint and prove:
 *  1. the browser key set on the per-isolate holder reaches the wire as
 *     `Authorization` on a Pi-owned model call (beating env);
 *  2. rotating the holder rotates the wire key (no stale key);
 *  3. after an eviction with no key, the resumed run fails cleanly as
 *     `unanswered` (never under a stale key), and a retry with the key
 *     recovers.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry, type Harness as HarnessType } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_AGENT } from "../src/agent";
import {
  byokHarnessSettings,
  byokModels,
  createByokCredentialStore,
  createByokKeyHolder,
  type ByokKeyHolder,
} from "../src/pi-durable-byok";
import { sseAnswer } from "./pi-fixtures";

const CTX = BACKGROUND_CONTEXT;

function headerOf(init: unknown, name: string): string | undefined {
  const headers = (init as { headers?: unknown })?.headers;
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v.join(", ") : String(v);
  }
  return undefined;
}


type TestStorage = MemoryStorage | Awaited<ReturnType<typeof openNodeSqliteStorage>>;

async function openHarness(storage: TestStorage, holder: ByokKeyHolder): Promise<HarnessType> {
  return Harness.open(
    storage,
    {
      models: byokModels(holder),
      registry: createRegistry(),
      settings: byokHarnessSettings(holder, { retry: { enabled: false, maxRetries: 0, baseDelayMs: 10 } }),
    },
    CTX,
  );
}

async function rootConversation(harness: HarnessType) {
  return harness.root(CTX, { agent: { model: { provider: "opencode", modelId: "muse-spark-1.3" } } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("byok credential store", () => {
  it("serves the holder key for BYOK providers only", async () => {
    const store = createByokCredentialStore({ current: { type: "api_key", key: "byok-1" } });
    expect(await store.read("opencode")).toEqual({ type: "api_key", key: "byok-1" });
    expect(await store.read("opencode-go")).toEqual({ type: "api_key", key: "byok-1" });
    expect(await store.read("openai")).toBeUndefined();
    expect(await createByokCredentialStore({ current: undefined }).read("opencode")).toBeUndefined();
    expect(await createByokCredentialStore({ current: { type: "api_key", key: "  " } }).read("opencode")).toBeUndefined();
  });

  it("lists metadata without secrets, and mutates the holder on modify/delete", async () => {
    const holder = createByokKeyHolder();
    holder.current = { type: "api_key", key: "byok-1" };
    const store = createByokCredentialStore(holder);
    const listed = await store.list();
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain("byok-1");

    await store.modify("opencode", async () => ({ type: "api_key", key: "byok-2" }));
    expect(holder.current).toEqual({ type: "api_key", key: "byok-2" });
    await store.delete("opencode");
    expect(holder.current).toBeUndefined();
    expect(await store.read("opencode")).toBeUndefined();
  });

  it("stores modify results verbatim and keeps no-ops unchanged", async () => {
    const holder = createByokKeyHolder();
    holder.current = { type: "api_key", key: "byok-1" };
    const store = createByokCredentialStore(holder);
    // Env overlay and metadata survive the round-trip (previous shape dropped them).
    const withEnv = { type: "api_key", key: "byok-1", env: { FOO: "bar" } } as const;
    await store.modify("opencode", async () => withEnv);
    expect(await store.read("opencode")).toEqual(withEnv);
    // A no-op modify must not wipe the key.
    await store.modify("opencode", async () => undefined);
    expect(await store.read("opencode")).toEqual(withEnv);
  });
});

describe("BYOK in Pi-owned generations", () => {
  it("sends the holder key (not env) with session + user-agent, and stores the answer", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "env-decoy-must-lose");
    const fetchMock = vi.fn().mockResolvedValueOnce(sseAnswer("pi says hi"));
    vi.stubGlobal("fetch", fetchMock);

    const storage = new MemoryStorage();
    const holder = createByokKeyHolder();
    holder.current = { type: "api_key", key: "byok-durable-1" };
    const harness = await openHarness(storage, holder);
    try {
      const root = await rootConversation(harness);
      const settled = await (
        await root.submit({ type: "input", content: "say hi", requestId: "byok-t1" }, CTX)
      ).wait(CTX);

      expect(settled.status).toBe("done");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url.startsWith("https://opencode.ai/zen/v1")).toBe(true);
      expect(headerOf(init, "authorization")).toBe("Bearer byok-durable-1");
      expect(headerOf(init, "x-opencode-session")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(headerOf(init, "user-agent")).toBe(USER_AGENT);

      const view = await root.context(CTX);
      expect(JSON.stringify(view.messages)).toContain("pi says hi");
    } finally {
      await harness.close(CTX);
    }
  });

  it("rotates the wire key when the holder rotates", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "env-decoy-must-lose");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sseAnswer("one"))
      .mockResolvedValueOnce(sseAnswer("two"));
    vi.stubGlobal("fetch", fetchMock);

    const storage = new MemoryStorage();
    const holder = createByokKeyHolder();
    const harness = await openHarness(storage, holder);
    try {
      const root = await rootConversation(harness);
      holder.current = { type: "api_key", key: "key-A" };
      const first = await (await root.submit({ type: "input", content: "one", requestId: "rot-1" }, CTX)).wait(CTX);
      holder.current = { type: "api_key", key: "key-B" };
      const second = await (await root.submit({ type: "input", content: "two", requestId: "rot-2" }, CTX)).wait(CTX);

      expect(first.status).toBe("done");
      expect(second.status).toBe("done");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(headerOf(fetchMock.mock.calls[0]?.[1], "authorization")).toBe("Bearer key-A");
      expect(headerOf(fetchMock.mock.calls[1]?.[1], "authorization")).toBe("Bearer key-B");
    } finally {
      await harness.close(CTX);
    }
  });

  it("fails cleanly after eviction with no key, then recovers on retry with the key", async () => {
    // File-backed storage: the isolate dies but SQLite survives, like a DO.
    const dir = await mkdtemp(join(tmpdir(), "pi-eviction-"));
    const dbPath = join(dir, "session.sqlite");
    try {
      // First isolate: request hangs mid-flight, then the isolate dies.
      const hanging = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      );
      vi.stubGlobal("fetch", hanging);

      const storage1 = await openNodeSqliteStorage(dbPath);
      const holder1 = createByokKeyHolder();
      holder1.current = { type: "api_key", key: "byok-evict" };
      const harness1 = await openHarness(storage1, holder1);
      const root1 = await rootConversation(harness1);
      const pending = await root1.submit({ type: "input", content: "hi", requestId: "evict-1" }, CTX);
      // Wait for the in-flight case (not a queued submission): the first
      // request must reach the wire before the isolate dies.
      await vi.waitFor(
        () => {
          if (hanging.mock.calls.length === 0) throw new Error("model request not started yet");
        },
        { timeout: 5000, interval: 10 },
      );
      expect(headerOf(hanging.mock.calls[0]?.[1], "authorization")).toBe("Bearer byok-evict");
      await harness1.close(CTX);

      // Second isolate: same storage, no key in memory (eviction cleared it).
      // A decoy env key pins the fallback behavior: the resumed run may use
      // the environment, but never the evicted holder key.
      vi.stubEnv("OPENCODE_API_KEY", "env-decoy-after-eviction");
      const failing = vi.fn().mockResolvedValue(new Response("bad key", { status: 401 }));
      vi.stubGlobal("fetch", failing);
      const storage2 = await openNodeSqliteStorage(dbPath);
      const holder2 = createByokKeyHolder();
      const harness2 = await openHarness(storage2, holder2);
      try {
        harness2.resume();
        const reacquired = await harness2.submission(pending.id, CTX);
        if (!reacquired) throw new Error("expected the pending submission to survive reopen");
        const settled = await reacquired.wait(CTX);

        // Clean failure, not a hang — and never under the evicted holder key
        // (the decoy env key may legitimately appear via env fallback).
        expect(settled.status).toBe("unanswered");
        for (const call of failing.mock.calls) {
          expect(headerOf(call[1], "authorization")).not.toBe("Bearer byok-evict");
        }

        // Retry with the key (still in the browser) recovers on the same storage.
        // The mock answers regardless of credentials, so the header assertion
        // below is what proves the key actually reached the request.
        const retryFetch = vi.fn().mockResolvedValue(sseAnswer("recovered"));
        vi.stubGlobal("fetch", retryFetch);
        holder2.current = { type: "api_key", key: "byok-back" };
        const root2 = await harness2.root(CTX);
        const retry = await (
          await root2.submit({ type: "input", content: "hi again", requestId: "evict-2" }, CTX)
        ).wait(CTX);
        expect(retry.status).toBe("done");
        expect(retryFetch).toHaveBeenCalled();
        for (const call of retryFetch.mock.calls) {
          expect(headerOf(call[1], "authorization")).toBe("Bearer byok-back");
        }
      } finally {
        await harness2.close(CTX);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
