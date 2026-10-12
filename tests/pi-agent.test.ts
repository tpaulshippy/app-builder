import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { type SessionApi } from "../src/agent";
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

  it("surfaces a 401 from Pi with the browser-key hint", async () => {
    const session = memorySession();
    const driver = fakeDriver(new Error("pi model request failed: 401 Unauthorized"));

    const events = [];
    for await (const e of piAgentTurn(session, "key", "hi", {}, { streamTurn: driver })) events.push(e);

    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect((events.at(-1) as { message: string }).message).toContain("401");
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
    ];

    const out = chatHistoryToPiMessages(history, "opencode", "muse-spark-1.3");
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "toolResult"]);
    const second = out[2];
    if (second?.role !== "assistant") throw new Error("expected assistant");
    expect(second.content).toMatchObject([{ type: "toolCall", id: "call_1", name: "bash" }]);
  });
});
