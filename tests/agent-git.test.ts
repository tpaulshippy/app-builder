import { afterEach, describe, expect, it, vi } from "vitest";
import { agentTurn, type SessionApi } from "../src/agent";
import type { ChatMessage, FileMap } from "../src/session";

function memorySession(): SessionApi & { files: FileMap; messages: ChatMessage[] } {
  const s: { files: FileMap; messages: ChatMessage[] } & SessionApi = {
    files: { "index.ts": "v1" } as FileMap,
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
      return { ok: true, html: "<p>ok</p>", logs: [], durationMs: 1, files };
    },
    gitStatus: async () => "?? index.ts",
    gitLog: async () => "abc123 initial",
    gitRun: async (command: string) => ({ ok: true, stdout: `ran ${command}`, stderr: "" }),
  };
  return s;
}

function chatReply(message: unknown): Response {
  return Response.json({ choices: [{ message }] });
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
          chatReply({
            content: "",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "git_status", arguments: "{}" } },
            ],
          }),
        )
        .mockResolvedValueOnce(chatReply({ content: "clean-ish" })),
    );
    const events = [];
    for await (const e of agentTurn(session, "key", "status?")) events.push(e);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[0]).toMatchObject({ detail: expect.stringContaining("?? index.ts") });
  });

  it("runs git subcommands through the allowlisted runner", async () => {
    const session = memorySession();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          chatReply({
            content: "",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "git", arguments: JSON.stringify({ command: "diff --stat" }) },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(chatReply({ content: "done" })),
    );
    const events = [];
    for await (const e of agentTurn(session, "key", "diff?")) events.push(e);
    expect(events.some((e) => e.type === "tool" && (e as { detail?: string }).detail === "git diff --stat")).toBe(
      true,
    );
  });

  it("rejects an empty git command", async () => {
    const session = memorySession();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          chatReply({
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "git", arguments: "{}" } }],
          }),
        )
        .mockResolvedValueOnce(chatReply({ content: "sorry" })),
    );
    const events = [];
    for await (const e of agentTurn(session, "key", "git?")) events.push(e);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0]).toMatchObject({ ok: false });
  });
});
