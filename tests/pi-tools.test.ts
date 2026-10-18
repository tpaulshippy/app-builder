/**
 * Slice (b) evidence: the capsule extension drives real Pi-owned tool
 * rounds. A mocked OpenCode endpoint first answers with function calls,
 * then with prose; the Harness executes the tools against the session and
 * the run settles done with files changed and build feedback on record.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry, type Harness as HarnessType } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SessionApi } from "../src/agent";
import { byokHarnessSettings, byokModels, createByokKeyHolder } from "../src/pi-durable-byok";
import { CAPSULE_TOOL_NAMES, createCapsuleExtension } from "../src/pi-tools";
import { sseAnswer, sseToolCall } from "./pi-fixtures";
import type { ChatMessage, FileMap } from "../src/session";

const CTX = BACKGROUND_CONTEXT;

function memorySession(initial: FileMap = { "server/index.ts": "v1" }): SessionApi & {
  files: FileMap;
  messages: ChatMessage[];
  builds: number;
  execs: string[];
  gitRuns: string[];
} {
  const s = {
    files: { ...initial },
    messages: [] as ChatMessage[],
    builds: 0,
    execs: [] as string[],
    gitRuns: [] as string[],
    getFiles: async () => ({ ...s.files }),
    setFiles: async (f: FileMap) => {
      s.files = { ...f };
    },
    getMessages: async () => [...s.messages],
    setMessages: async (m: ChatMessage[]) => {
      s.messages = [...m];
    },
    build: async (f?: FileMap) => {
      s.builds++;
      const files = f ?? s.files;
      return { ok: true, tables: ["todos"], queries: {}, logs: [], durationMs: 1, files };
    },
    exec: async (command: string, f?: FileMap) => {
      s.execs.push(command);
      const files = { ...(f ?? s.files) };
      return { stdout: "ok", stderr: "", exitCode: 0, files };
    },
    gitStatus: async () => "M server/index.ts",
    gitLog: async () => "abc123 first commit",
    gitRun: async (command: string) => {
      s.gitRuns.push(command);
      // Simulate a worktree-changing subcommand so the test can prove the
      // FileMap sync; anything else leaves files untouched. Persist here
      // like the real session.gitRun does internally.
      const files = command.startsWith("checkout")
        ? { ...s.files, "server/index.ts": "checked-out" }
        : { ...s.files };
      s.files = files;
      return { ok: true, stdout: "git-ok", stderr: "", files };
    },
  };
  return s;
}

async function openToolHarness(session: SessionApi, key: string): Promise<HarnessType> {
  const holder = createByokKeyHolder();
  holder.current = { type: "api_key", key };
  const registry = createRegistry();
  registry.install(createCapsuleExtension(session));
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: byokModels(holder),
      registry,
      settings: byokHarnessSettings(holder, { retry: { enabled: false, maxRetries: 0, baseDelayMs: 10 } }),
    },
    CTX,
  );
  return harness;
}

async function runTurn(
  harness: HarnessType,
  content: string,
  requestId: string,
): Promise<{ status: string; transcript: string }> {
  const root = await harness.root(CTX, { agent: { model: { provider: "opencode", modelId: "muse-spark-1.3" } } });
  const settled = await (await root.submit({ type: "input", content, requestId }, CTX)).wait(CTX);
  const view = await root.context(CTX);
  return { status: settled.status, transcript: JSON.stringify(view.messages) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("capsule extension tool rounds", () => {
  it("write_file changes the file and records build feedback", async () => {
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
    const session = memorySession();
    const harness = await openToolHarness(session, "byok-tools-1");
    try {
      const { status, transcript } = await runTurn(harness, "rewrite it", "tools-t1");
      expect(status).toBe("done");
      expect(session.files["server/index.ts"]).toBe("v2");
      expect(session.builds).toBeGreaterThanOrEqual(1);
      expect(transcript).toContain("build passed");
      expect(transcript).toContain("done");
    } finally {
      await harness.close(CTX);
    }
  });

  it("bash runs the dev cycle through the shell", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          sseToolCall([{ callId: "call_1", id: "fc_1", name: "bash", args: { command: "build" } }]),
        )
        .mockResolvedValueOnce(sseAnswer("built")),
    );
    const session = memorySession();
    const harness = await openToolHarness(session, "byok-tools-1");
    try {
      const { status, transcript } = await runTurn(harness, "build it", "tools-t2");
      expect(status).toBe("done");
      expect(session.execs).toContain("build");
      expect(transcript).toContain("build passed");
    } finally {
      await harness.close(CTX);
    }
  });

  it("git_status returns repo status as text", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          sseToolCall([{ callId: "call_1", id: "fc_1", name: "git_status", args: {} }]),
        )
        .mockResolvedValueOnce(sseAnswer("clean enough")),
    );
    const session = memorySession();
    const harness = await openToolHarness(session, "byok-tools-1");
    try {
      const { status, transcript } = await runTurn(harness, "check status", "tools-git1");
      expect(status).toBe("done");
      expect(transcript).toContain("M server/index.ts");
    } finally {
      await harness.close(CTX);
    }
  });

  it("git mutating commands sync the worktree files", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          sseToolCall([{ callId: "call_1", id: "fc_1", name: "git", args: { command: "checkout main" } }]),
        )
        .mockResolvedValueOnce(sseAnswer("switched")),
    );
    const session = memorySession();
    const harness = await openToolHarness(session, "byok-tools-1");
    try {
      const { status } = await runTurn(harness, "switch branch", "tools-git2");
      expect(status).toBe("done");
      expect(session.gitRuns).toContain("checkout main");
      expect(session.files["server/index.ts"]).toBe("checked-out");
    } finally {
      await harness.close(CTX);
    }
  });

  it("caps verbose tool results at the transcript cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          sseToolCall([{ callId: "call_1", id: "fc_1", name: "read_file", args: { path: "server/big.txt" } }]),
        )
        .mockResolvedValueOnce(sseAnswer("saw it")),
    );
    const session = memorySession({ "server/big.txt": "x".repeat(20000) });
    const harness = await openToolHarness(session, "byok-tools-1");
    try {
      const root = await harness.root(CTX, { agent: { model: { provider: "opencode", modelId: "muse-spark-1.3" } } });
      const settled = await (
        await root.submit({ type: "input", content: "read it", requestId: "tools-t6" }, CTX)
      ).wait(CTX);
      expect(settled.status).toBe("done");
      const view = await root.context(CTX);
      const results = view.messages.filter((m) => m.role === "toolResult");
      expect(results).toHaveLength(1);
      const text = JSON.stringify(results[0]);
      expect(text.length).toBeLessThanOrEqual(8000 + 500);
      expect(text).toContain("x".repeat(100));
      expect(text).toContain("truncated");
    } finally {
      await harness.close(CTX);
    }
  });

  it("read_file returns contents without shell quoting", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          sseToolCall([{ callId: "call_1", id: "fc_1", name: "read_file", args: { path: "server/index.ts" } }]),
        )
        .mockResolvedValueOnce(sseAnswer("saw it")),
    );
    const session = memorySession();
    const harness = await openToolHarness(session, "byok-tools-1");
    try {
      const { status, transcript } = await runTurn(harness, "read it", "tools-t3");
      expect(status).toBe("done");
      expect(transcript).toContain("v1");
    } finally {
      await harness.close(CTX);
    }
  });

  it("parallel writes in one round both land (writes run sequentially)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          sseToolCall([
            { callId: "call_1", id: "fc_1", name: "write_file", args: { path: "server/a.txt", content: "aaa" } },
            { callId: "call_2", id: "fc_2", name: "write_file", args: { path: "server/b.txt", content: "bbb" } },
          ]),
        )
        .mockResolvedValueOnce(sseAnswer("both written")),
    );
    const session = memorySession();
    // Slow builds force the losing interleave when writes run in parallel:
    // both reads resolve before either write lands, so the later setFiles
    // would drop the earlier edit. Sequential execution must still land both.
    const innerBuild = session.build;
    session.build = async (f) => {
      await new Promise((r) => setTimeout(r, 60));
      return innerBuild(f);
    };
    const harness = await openToolHarness(session, "byok-tools-1");
    try {
      const { status } = await runTurn(harness, "write both", "tools-t5");
      expect(status).toBe("done");
      expect(session.files["server/a.txt"]).toBe("aaa");
      expect(session.files["server/b.txt"]).toBe("bbb");
    } finally {
      await harness.close(CTX);
    }
  });

  it("an unsafe write fails the call without touching files, and the run continues", async () => {    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          sseToolCall([{ callId: "call_1", id: "fc_1", name: "write_file", args: { path: "../evil.ts", content: "x" } }]),
        )
        .mockResolvedValueOnce(sseAnswer("refused, moving on")),
    );
    const session = memorySession();
    const harness = await openToolHarness(session, "byok-tools-1");
    try {
      const { status, transcript } = await runTurn(harness, "pwn it", "tools-t4");
      expect(status).toBe("done");
      expect(session.files["server/index.ts"]).toBe("v1");
      expect("evil.ts" in session.files).toBe(false);
      expect(transcript).toContain("refusing unsafe path");
    } finally {
      await harness.close(CTX);
    }
  });
});

describe("capsule extension shape", () => {
  it("marks replay policy per tool and bash sequential", () => {
    const registry = createRegistry();
    registry.install(createCapsuleExtension(memorySession()));
    const tools = registry.snapshot().tools();
    const byName = Object.fromEntries(tools.map((t) => [t.tool.name, t.tool]));
    expect(byName["bash"]).toMatchObject({ replay: "unsafe", executionMode: "sequential" });
    expect(byName["read_file"]).toMatchObject({ replay: "safe" });
    // Unsafe: a crash between persisting and recovery could replay a stale
    // whole-file replacement over a newer editor save.
    expect(byName["write_file"]).toMatchObject({ replay: "unsafe", executionMode: "sequential" });
    expect(byName["git_status"]).toMatchObject({ replay: "safe" });
    expect(byName["git_log"]).toMatchObject({ replay: "safe" });
    // Unsafe: may commit or push — never replay after a crash.
    expect(byName["git"]).toMatchObject({ replay: "unsafe", executionMode: "sequential" });
    // The exported name list must match the registry exactly, or probes
    // using it go stale silently.
    expect(Object.keys(byName).sort()).toEqual([...CAPSULE_TOOL_NAMES].sort());
  });

  it("carries the capsule instructions as an untagged preamble section", async () => {
    const registry = createRegistry();
    registry.install(createCapsuleExtension(memorySession()));
    const sections = registry.snapshot().sections();
    expect(sections).toHaveLength(1);
    const text = await sections[0]?.section.render({} as never, {} as never);
    expect(text).toContain("capsule");
    expect(text).toContain("git_status");
  });
});
