import { afterEach, describe, expect, it, vi } from "vitest";
import { agentTurn, type SessionApi } from "../src/agent";
import type { ChatMessage, FileMap } from "../src/session";

function memorySession(initial: FileMap = { "index.ts": "v1" }): SessionApi & {
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
      return { ok: true, html: "<p>ok</p>", logs: [], durationMs: 1, files };
    },
  };
  return s;
}

function chatReply(message: unknown): Response {
  return Response.json({ choices: [{ message }] });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agentTurn", () => {
  it("writes a file, builds, then finishes", async () => {
    const session = memorySession();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        chatReply({
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "index.ts", content: "v2" }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        chatReply({
          content: "",
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: { name: "build", arguments: "{}" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(chatReply({ content: "done" }));
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const e of agentTurn(session, "key", "hi")) events.push(e);

    expect(session.files["index.ts"]).toBe("v2");
    expect(events.some((e) => e.type === "build")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refuses an unsafe write_file path", async () => {
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
                id: "call_1",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "../evil.ts", content: "x" }),
                },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(chatReply({ content: "refused, sorry" })),
    );

    const events = [];
    for await (const e of agentTurn(session, "key", "pwn")) events.push(e);

    expect(session.files["index.ts"]).toBe("v1");
    expect("evil.ts" in session.files).toBe(false);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0]).toMatchObject({ ok: false });
  });
});
