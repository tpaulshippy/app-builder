import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { type SessionApi } from "../src/agent";
import { execCapsuleTool, isDevCycleCommand } from "../src/capsule-tool-exec";
import { chatHistoryToPiMessages, piAgentTurn } from "../src/pi-agent";
import type { PiToolCall, PiTurnOptions, PiTurnResult } from "../src/pi-opencode";
import type { ChatMessage, FileMap } from "../src/session";

function memorySession(initial: FileMap = { "server/index.ts": "v1" }): SessionApi & {
  files: FileMap;
  messages: ChatMessage[];
} {
  const s = {
    files: { ...initial },
    messages: [] as ChatMessage[],
    getFiles: async () => ({ ...s.files }),
    setFiles: async (f: FileMap) => {
      s.files = { ...f };
    },
    getMessages: async () => [...s.messages],
    setMessages: async (m: ChatMessage[]) => {
      s.messages = [...m];
    },
    build: async (f?: FileMap) => {
      const files = f ?? s.files;
      return { ok: true, tables: ["todos"], queries: {}, logs: [], durationMs: 1, files };
    },
    exec: async (command: string, f?: FileMap) => {
      const files = { ...(f ?? s.files) };
      if (command.includes("write")) files["server/index.ts"] = "v2";
      s.files = { ...files };
      return { stdout: "ok", stderr: "", exitCode: 0, files };
    },
  };
  return s;
}

function textTurn(text: string): PiTurnResult {
  return { text, toolCalls: [], message: {} as PiTurnResult["message"] };
}

function toolTurn(calls: PiToolCall[], text = ""): PiTurnResult {
  return { text, toolCalls: calls, message: {} as PiTurnResult["message"] };
}

function fakeDriver(turns: PiTurnResult[] | Error) {
  const queue = Array.isArray(turns) ? [...turns] : [];
  return async (
    _apiKey: string,
    _messages: Message[],
    _system: string,
    _opts?: PiTurnOptions,
  ): Promise<PiTurnResult> => {
    if (turns instanceof Error) throw turns;
    const next = queue.shift();
    if (!next) throw new Error("no more fake turns");
    return next;
  };
}

describe("piAgentTurn", () => {
  it("writes a file then finishes, reusing the build feedback loop", async () => {
    const session = memorySession();
    const driver = fakeDriver([
      toolTurn([{ id: "call_1", name: "write_file", args: { path: "server/index.ts", content: "v2" } }]),
      textTurn("done"),
    ]);

    const events = [];
    for await (const e of piAgentTurn(session, "key", "hi", {}, { streamTurn: driver })) events.push(e);

    expect(session.files["server/index.ts"]).toBe("v2");
    expect(events.some((e) => e.type === "build")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(events.filter((e) => e.type === "tool")).toMatchObject([{ detail: "write server/index.ts" }]);
  });

  it("runs a bash command, refreshes the build, then finishes", async () => {
    const session = memorySession();
    const driver = fakeDriver([
      toolTurn([{ id: "call_1", name: "bash", args: { command: "build" } }]),
      textTurn("done"),
    ]);

    const events = [];
    for await (const e of piAgentTurn(session, "key", "hi", {}, { streamTurn: driver })) events.push(e);

    expect(events.some((e) => e.type === "build")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("refuses an unsafe write_file path", async () => {
    const session = memorySession();
    const driver = fakeDriver([
      toolTurn([{ id: "call_1", name: "write_file", args: { path: "../evil.ts", content: "x" } }]),
      textTurn("refused, sorry"),
    ]);

    const events = [];
    for await (const e of piAgentTurn(session, "key", "pwn", {}, { streamTurn: driver })) events.push(e);

    expect(session.files["server/index.ts"]).toBe("v1");
    expect("evil.ts" in session.files).toBe(false);
    expect(events.filter((e) => e.type === "tool_result")[0]).toMatchObject({ ok: false });
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("reads a file without shell quoting", async () => {
    const session = memorySession();
    const seen: Message[][] = [];
    const driver = async (
      _apiKey: string,
      messages: Message[],
      _system: string,
      _opts?: PiTurnOptions,
    ): Promise<PiTurnResult> => {
      seen.push(messages);
      return seen.length === 1
        ? toolTurn([{ id: "call_1", name: "read_file", args: { path: "server/index.ts" } }])
        : textTurn("done");
    };

    const events = [];
    for await (const e of piAgentTurn(session, "key", "hi", {}, { streamTurn: driver })) events.push(e);

    expect(events.at(-1)).toMatchObject({ type: "done" });
    // The tool result carrying the file contents replays into the next Pi transcript.
    const replay = seen[1] ?? [];
    const results = replay.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0])).toContain("v1");
  });

  it("replays failed tools as errors into later Pi rounds", async () => {
    const session = memorySession();
    const seen: Message[][] = [];
    const driver = async (
      _apiKey: string,
      messages: Message[],
      _system: string,
      _opts?: PiTurnOptions,
    ): Promise<PiTurnResult> => {
      seen.push(messages);
      return seen.length === 1
        ? toolTurn([{ id: "call_1", name: "write_file", args: { path: "../evil.ts", content: "x" } }])
        : textTurn("done");
    };

    const events = [];
    for await (const e of piAgentTurn(session, "key", "pwn", {}, { streamTurn: driver })) events.push(e);

    expect(events.at(-1)).toMatchObject({ type: "done" });
    const replay = seen[1] ?? [];
    const results = replay.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: true });
  });

  it("surfaces a 401 from Pi with the browser-key hint", async () => {
    const session = memorySession();
    const driver = fakeDriver(new Error("pi model request failed: 401 Unauthorized"));

    const events = [];
    for await (const e of piAgentTurn(session, "key", "hi", {}, { streamTurn: driver })) events.push(e);

    expect(events.at(-1)).toMatchObject({ type: "error" });
    const message = (events.at(-1) as { message: string }).message;
    expect(message).toContain("401");
    expect(message).toContain("check the API key");
  });

  it("persists one assistant message per Pi round (text + calls together)", async () => {
    const session = memorySession();
    const driver = fakeDriver([
      toolTurn([{ id: "call_1", name: "bash", args: { command: "build" } }], "building now"),
      textTurn("done"),
    ]);

    const events = [];
    for await (const e of piAgentTurn(session, "key", "hi", {}, { streamTurn: driver })) events.push(e);

    const stored = await session.getMessages();
    const assistants = stored.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]).toMatchObject({ content: "building now" });
    expect(assistants[0]?.tool_calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });
});

describe("isDevCycleCommand", () => {
  it("matches dev commands as segments, not substrings", () => {
    expect(isDevCycleCommand("build")).toBe(true);
    expect(isDevCycleCommand("ls server && build")).toBe(true);
    expect(isDevCycleCommand("tests 2>&1 | head")).toBe(true);
    expect(isDevCycleCommand("lint; deploy")).toBe(true);
    expect(isDevCycleCommand("ls | grep build")).toBe(false);
    expect(isDevCycleCommand("grep -l deploy *.ts")).toBe(false);
    expect(isDevCycleCommand("echo build")).toBe(false);
    expect(isDevCycleCommand("ls")).toBe(false);
  });
});

describe("execCapsuleTool", () => {
  it("returns fresh files (not the pre-command snapshot) when the shell times out", async () => {
    const session = memorySession();
    session.exec = (async () => {
      // Lands an edit, then hangs past the tool timeout: the late
      // setFiles still happens, so the outcome must re-read.
      const files = { ...(await session.getFiles()), ["server/late.txt"]: "landed" };
      await session.setFiles(files);
      return new Promise<{ stdout: string; stderr: string; exitCode: number; files: FileMap }>(() => {});
    }) as SessionApi["exec"];
    const outcome = await execCapsuleTool(session, await session.getFiles(), "bash", { command: "slow" }, 20);
    expect(outcome.ok).toBe(false);
    expect(outcome.files["server/late.txt"]).toBe("landed");
  });
});

describe("chatHistoryToPiMessages", () => {
  it("converts both transcript shapes (legacy split + Pi combined)", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "building" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ call_id: "call_1", name: "bash", arguments: JSON.stringify({ command: "build" }) }],
      },
      { role: "tool", content: "ok (exit 0)", name: "bash", tool_call_id: "call_1" },
      // Pi engine shape: one message carrying text and calls together.
      {
        role: "assistant",
        content: "writing now",
        tool_calls: [
          {
            call_id: "call_2",
            name: "write_file",
            arguments: JSON.stringify({ path: "server/index.ts", content: "v2" }),
          },
        ],
      },
      { role: "tool", content: "wrote server/index.ts", name: "write_file", tool_call_id: "call_2" },
    ];

    const out = chatHistoryToPiMessages(history, "opencode", "muse-spark-1.3");
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "toolResult", "assistant", "toolResult"]);
    const split = out[2];
    if (split?.role !== "assistant") throw new Error("expected assistant");
    expect(split.content).toMatchObject([{ type: "toolCall", id: "call_1", name: "bash" }]);
    const combined = out[4];
    if (combined?.role !== "assistant") throw new Error("expected assistant");
    expect(combined.content).toMatchObject([
      { type: "text", text: "writing now" },
      { type: "toolCall", id: "call_2", name: "write_file" },
    ]);
  });

  it("collapses the custom harness double-store (text-only + combined with the same text)", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "building now" },
      {
        role: "assistant",
        content: "building now",
        tool_calls: [{ call_id: "call_1", name: "bash", arguments: JSON.stringify({ command: "build" }) }],
      },
    ];

    const out = chatHistoryToPiMessages(history, "opencode", "muse-spark-1.3");
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    const first = out[1];
    if (first?.role !== "assistant") throw new Error("expected assistant");
    expect(first.content).toMatchObject([{ type: "text", text: "building now" }]);
    const second = out[2];
    if (second?.role !== "assistant") throw new Error("expected assistant");
    // Duplicate narration dropped; the tool call survives.
    expect(second.content).toMatchObject([{ type: "toolCall", id: "call_1", name: "bash" }]);
    expect(second.content.some((b) => b.type === "text")).toBe(false);
  });
});
