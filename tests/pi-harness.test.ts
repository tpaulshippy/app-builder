/**
 * Slice (c) evidence: the mapping layer between Pi-owned runs and the
 * existing UI/storage contracts, plus Harness composition (models behind
 * the BYOK store, capsule registry, live settings).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry, type EntryRecord } from "@earendil-works/pi-durable";
import type { Harness as HarnessType } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionApi } from "../src/agent";
import { byokHarnessSettings, byokModels, createByokKeyHolder } from "../src/pi-durable-byok";
import {
  mapPiEvents,
  migrateLegacyTranscript,
  openPiHarness,
  piDefaultsFor,
  piEntriesToChatMessages,
} from "../src/pi-harness";
import { createCapsuleExtension } from "../src/pi-tools";
import type { BuildResult, ChatMessage, FileMap } from "../src/session";
import { sseAnswer, sseToolCall } from "./pi-fixtures";

const CTX = BACKGROUND_CONTEXT;

function stubSession(): SessionApi {
  const fail = async (): Promise<never> => {
    throw new Error("must not run in mapper tests");
  };
  return {
    getFiles: async () => ({}) as FileMap,
    setFiles: async () => {},
    getMessages: async () => [] as ChatMessage[],
    setMessages: async () => {},
    build: fail as SessionApi["build"],
    exec: fail as SessionApi["exec"],
  };
}

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("piDefaultsFor", () => {
  it("maps the picker to Pi model references with gateway fallback", () => {
    expect(piDefaultsFor("zen", "muse-spark-1.3")).toEqual({ provider: "opencode", id: "muse-spark-1.3" });
    expect(piDefaultsFor("go", "muse-spark-1.3-contributor")).toEqual({
      provider: "opencode-go",
      id: "muse-spark-1.3-contributor",
    });
    expect(piDefaultsFor("go", "muse-spark-1.3")).toEqual({
      provider: "opencode-go",
      id: "muse-spark-1.3-contributor",
    });
  });
});

describe("piEntriesToChatMessages", () => {
  it("converts user/assistant/tool entries and skips system bookkeeping", () => {
    const entries = [
      { id: "e1", conversationId: "c", kind: "pi.user", model: [{ role: "user", content: "hi", timestamp: 1 }] },
      {
        id: "e2",
        conversationId: "c",
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "building" },
              { type: "toolCall", id: "call_1|fc_1", name: "bash", arguments: { command: "build" } },
            ],
            api: "openai-responses",
            provider: "opencode",
            model: "muse-spark-1.3",
            usage: zeroUsage,
            stopReason: "toolUse",
            timestamp: 2,
          },
        ],
      },
      {
        id: "e3",
        conversationId: "c",
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "call_1|fc_1",
            toolName: "bash",
            content: [{ type: "text", text: "$ build\nok" }],
            isError: false,
            timestamp: 3,
          },
        ],
      },
      { id: "e0", conversationId: "c", kind: "pi.system", model: [] },
    ] as unknown as EntryRecord[];

    expect(piEntriesToChatMessages(entries)).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "building",
        tool_calls: [{ call_id: "call_1|fc_1", name: "bash", arguments: JSON.stringify({ command: "build" }) }],
      },
      { role: "tool", content: "$ build\nok", name: "bash", tool_call_id: "call_1|fc_1", isError: false },
    ]);
  });
});

describe("mapPiEvents", () => {
  it("streams text deltas, tool starts, and tool-result entries; drops orchestration noise", () => {
    const toolEntry = {
      id: "e3",
      conversationId: "c",
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: "call_1|fc_1",
          toolName: "write_file",
          content: [{ type: "text", text: "wrote server/index.ts (10 chars)\nbuild passed" }],
          isError: false,
          timestamp: 3,
        },
      ],
    } as unknown as EntryRecord;

    const out = mapPiEvents([
      { type: "message_update", usage: zeroUsage, changes: [{ type: "text_delta", contentIndex: 0, delta: "hel" }] },
      { type: "message_update", usage: zeroUsage, changes: [{ type: "thinking_delta", contentIndex: 1, delta: "hmm" }] },
      { type: "tool_execution_start", toolCallId: "call_1|fc_1", toolName: "write_file", args: { path: "server/index.ts" } },
      { type: "message_end", entry: toolEntry },
      { type: "entry_appended", entry: toolEntry },
      { type: "run_end", inputs: [] },
      { type: "submission", record: {} },
    ] as never);

    expect(out).toEqual([
      { type: "text", text: "hel" },
      { type: "tool", name: "write_file", detail: "write server/index.ts" },
      {
        type: "tool_result",
        name: "write_file",
        ok: true,
        detail: "wrote server/index.ts (10 chars)\nbuild passed",
      },
    ]);
  });
});

describe("migrateLegacyTranscript", () => {
  const legacy: ChatMessage[] = [
    { role: "user", content: "build a todo app" },
    { role: "assistant", content: "on it" },
    {
      role: "assistant",
      content: "on it",
      tool_calls: [{ call_id: "call_1", name: "write_file", arguments: JSON.stringify({ path: "a", content: "b" }) }],
    },
    { role: "tool", content: "wrote a", name: "write_file", tool_call_id: "call_1" },
    // Unpaired call: rejected on replay, must not migrate.
    {
      role: "assistant",
      content: "also this",
      tool_calls: [{ call_id: "call_orphan", name: "bash", arguments: "{}" }],
    },
  ];

  async function openEmpty(): Promise<HarnessType> {
    const holder = createByokKeyHolder();
    return Harness.open(
      new MemoryStorage(),
      { models: byokModels(holder), registry: createRegistry(), settings: byokHarnessSettings(holder) },
      CTX,
    );
  }

  it("imports legacy history once, skips unpaired calls, and never re-imports", async () => {
    const harness = await openEmpty();
    try {
      const first = await migrateLegacyTranscript(harness, legacy, "opencode", "muse-spark-1.3", CTX);
      expect(first).toBe(true);
      const root = await harness.root(CTX);
      const entries = await root.entries({ order: "ascending" } as never, 100, undefined, CTX);
      const kinds = entries.items.map((e) => e.kind);
      expect(kinds).toEqual(["pi.user", "pi.assistant", "pi.assistant", "pi.tool-result", "pi.assistant"]);
      // The orphan call's narration survives; its tool call does not.
      expect(JSON.stringify(entries.items[4])).toContain("also this");
      expect(JSON.stringify(entries.items[4])).not.toContain("call_orphan");

      // The imported transcript round-trips back to ChatMessages.
      const roundTripped = piEntriesToChatMessages(entries.items);
      expect(roundTripped[0]).toMatchObject({ role: "user", content: "build a todo app" });

      // Second call is a no-op: Pi is no longer empty.
      const second = await migrateLegacyTranscript(harness, legacy, "opencode", "muse-spark-1.3", CTX);
      expect(second).toBe(false);
      const again = await root.entries({ order: "ascending" } as never, 100, undefined, CTX);
      expect(again.items).toHaveLength(entries.items.length);
    } finally {
      await harness.close(CTX);
    }
  });

  it("drops tool results whose call fell outside the import window", async () => {
    const harness = await openEmpty();
    try {
      // Call stored pre-window, result in-window: importing the result
      // alone would leave Pi replaying an unmatched output and failing.
      const legacy: ChatMessage[] = [
        {
          role: "assistant",
          content: "old",
          tool_calls: [{ call_id: "call_old", name: "bash", arguments: "{}" }],
        },
        { role: "tool", content: "old output", name: "bash", tool_call_id: "call_old" },
      ];
      const windowed = legacy.slice(-1);
      const first = await migrateLegacyTranscript(harness, windowed, "opencode", "muse-spark-1.3", CTX);
      expect(first).toBe(false);
      const root = await harness.root(CTX);
      const entries = await root.entries({ order: "ascending" } as never, 100, undefined, CTX);
      expect(entries.items).toHaveLength(0);
    } finally {
      await harness.close(CTX);
    }
  });

  it("does nothing when there is no legacy history", async () => {
    const harness = await openEmpty();
    try {
      expect(await migrateLegacyTranscript(harness, [], "opencode", "muse-spark-1.3", CTX)).toBe(false);
    } finally {
      await harness.close(CTX);
    }
  });
});

describe("openPiHarness composition", () => {
  async function open(holderKey: string | undefined): Promise<HarnessType> {
    const holder = createByokKeyHolder();
    holder.current = holderKey ? { type: "api_key", key: holderKey } : undefined;
    // Registry/models intentionally default-composed here (no capsule
    // extension): these cases fail before tools matter, distinguishing
    // auth wiring from model/catalog wiring.
    return Harness.open(
      new MemoryStorage(),
      { models: byokModels(holder), registry: createRegistry(), settings: byokHarnessSettings(holder) },
      CTX,
    );
  }

  it("resolves auth from the holder: no key fails before dispatch", async () => {
    const harness = await open(undefined);
    try {
      const root = await harness.root(CTX, { agent: { model: { provider: "opencode", modelId: "muse-spark-1.3" } } });
      const settled = await (
        await root.submit({ type: "input", content: "hi", requestId: "comp-1" }, CTX)
      ).wait(CTX);
      expect(settled.status).toBe("unanswered");
      // Auth wiring, not catalog wiring: the failure names the provider.
      expect(settled.reason).toBe("model_error");
    } finally {
      await harness.close(CTX);
    }
  });

  it("fails distinctly for a model outside the catalog", async () => {
    const harness = await open("byok-x");
    try {
      const root = await harness.root(CTX, { agent: { model: { provider: "opencode", modelId: "no-such-model" } } });
      const settled = await (
        await root.submit({ type: "input", content: "hi", requestId: "comp-2" }, CTX)
      ).wait(CTX);
      expect(settled.status).toBe("unanswered");
      // Catalog wiring, not auth wiring: fails before any provider request.
      expect(settled.reason).toBe("no_model");
    } finally {
      await harness.close(CTX);
    }
  });

  it("opens the capsule composition used in production", async () => {
    const holder = createByokKeyHolder();
    const session = stubSession();
    const builds: BuildResult[] = [];
    const harness = await openPiHarness(new MemoryStorage(), CTX, {
      holder,
      session,
      onBuild: (b) => builds.push(b),
    });
    try {
      const root = await harness.root(CTX, { agent: { model: { provider: "opencode", modelId: "muse-spark-1.3" } } });
      // No key: fails on auth, but only after preparation renders the
      // capsule section and tool loadout — proving the composition.
      const settled = await (
        await root.submit({ type: "input", content: "hi", requestId: "comp-3" }, CTX)
      ).wait(CTX);
      expect(settled.status).toBe("unanswered");
      expect(settled.reason).toBe("model_error");
      expect(builds).toEqual([]);
      expect(createCapsuleExtension(session).tools).toHaveLength(3);
    } finally {
      await harness.close(CTX);
    }
  });

  it("drives an authenticated tool call through the production composition", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          sseToolCall([
            { callId: "call_1", id: "fc_1", name: "write_file", args: { path: "server/index.ts", content: "v2" } },
          ]),
        )
        .mockResolvedValueOnce(sseAnswer("done")),
    );
    const files: FileMap = { "server/index.ts": "v1" };
    let builds = 0;
    const session: SessionApi = {
      getFiles: async () => ({ ...files }),
      setFiles: async (f) => {
        for (const k of Object.keys(files)) if (!(k in f)) delete files[k];
        Object.assign(files, f);
      },
      getMessages: async () => [] as ChatMessage[],
      setMessages: async () => {},
      build: async (f) => {
        builds++;
        const current = f ?? files;
        return { ok: true, tables: ["todos"], queries: {}, logs: [], durationMs: 1, files: current };
      },
      exec: async (command, f) => ({ stdout: "ok", stderr: "", exitCode: 0, files: { ...(f ?? files) } }),
    };
    const seenBuilds: BuildResult[] = [];
    const holder = createByokKeyHolder();
    holder.current = { type: "api_key", key: "byok-comp" };
    const harness = await openPiHarness(new MemoryStorage(), CTX, {
      holder,
      session,
      onBuild: (b) => seenBuilds.push(b),
    });
    try {
      const root = await harness.root(CTX, { agent: { model: { provider: "opencode", modelId: "muse-spark-1.3" } } });
      const settled = await (
        await root.submit({ type: "input", content: "rewrite it", requestId: "comp-4" }, CTX)
      ).wait(CTX);
      expect(settled.status).toBe("done");
      expect(files["server/index.ts"]).toBe("v2");
      expect(builds).toBeGreaterThanOrEqual(1);
      expect(seenBuilds).toHaveLength(builds);
    } finally {
      await harness.close(CTX);
    }
  });
});
