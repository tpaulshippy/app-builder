import { afterEach, describe, expect, it, vi } from "vitest";
import { agentTurn, type SessionApi } from "../src/agent";
import type { ChatMessage, FileMap } from "../src/session";

function memorySession(): SessionApi & {
  files: FileMap;
  messages: ChatMessage[];
} {
  const s: { files: FileMap; messages: ChatMessage[] } & SessionApi = {
    files: { "server/index.ts": "v1" } as FileMap,
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
      const files = (f ?? s.files) as FileMap;
      return { ok: true, tables: ["todos"], queries: {}, logs: [], durationMs: 1, files };
    },
    exec: async (command: string, f?: FileMap) => {
      const files = { ...((f ?? s.files) as FileMap) };
      s.files = { ...files };
      return { stdout: "ok", stderr: "", exitCode: 0, files };
    },
    gitStatus: async () => "?? server/index.ts",
    gitLog: async () => "abc123 initial",
    gitRun: async (command: string) => ({ ok: true, stdout: `ran ${command}`, stderr: "" }),
  };
  return s;
}

function responsesReply(output: unknown[]): Response {
  return Response.json({ output });
}

function textMsg(text: string): Response {
  return responsesReply([{ type: "message", content: [{ type: "output_text", text }] }]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent git tools", () => {
  it("answers git_status from the session", async () => {
    const session = memorySession();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          responsesReply([
            { type: "function_call", call_id: "c1", name: "git_status", arguments: "{}" },
          ]),
        )
        .mockResolvedValueOnce(textMsg("clean-ish")),
    );
    const events = [];
    for await (const e of agentTurn(session, "key", "status?")) events.push(e);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[0]).toMatchObject({ detail: expect.stringContaining("?? server/index.ts") });
  });

  it("runs git subcommands through the allowlisted runner", async () => {
    const session = memorySession();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          responsesReply([
            {
              type: "function_call",
              call_id: "c1",
              name: "git",
              arguments: JSON.stringify({ command: "diff --stat" }),
            },
          ]),
        )
        .mockResolvedValueOnce(textMsg("done")),
    );
    const events = [];
    for await (const e of agentTurn(session, "key", "diff?")) events.push(e);
    expect(
      events.some((e) => e.type === "tool" && (e as { detail?: string }).detail === "git diff --stat"),
    ).toBe(true);
    // The tool result carries the runner's output, proving the command ran.
    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[0]).toMatchObject({ detail: expect.stringContaining("ran diff --stat") });
  });

  it("rejects an empty git command", async () => {
    const session = memorySession();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          responsesReply([{ type: "function_call", call_id: "c1", name: "git", arguments: "{}" }]),
        )
        .mockResolvedValueOnce(textMsg("sorry")),
    );
    const events = [];
    for await (const e of agentTurn(session, "key", "git?")) events.push(e);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0]).toMatchObject({ ok: false });
  });

  it("reports a throwing git runner as a failed tool, not a dead turn", async () => {
    const session = memorySession();
    session.gitRun = async () => {
      throw new Error("network down");
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          responsesReply([
            {
              type: "function_call",
              call_id: "c1",
              name: "git",
              arguments: JSON.stringify({ command: "push" }),
            },
          ]),
        )
        .mockResolvedValueOnce(textMsg("noted")),
    );
    const events = [];
    for await (const e of agentTurn(session, "key", "push?")) events.push(e);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]).toMatchObject({ detail: expect.stringContaining("network down") });
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });
});
