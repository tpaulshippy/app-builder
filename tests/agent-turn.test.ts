import { afterEach, describe, expect, it, vi } from "vitest";
import { agentTurn, type SessionApi } from "../src/agent";
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

function responsesReply(output: unknown[]): Response {
  return Response.json({ output });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agentTurn", () => {
  it("runs a bash command, refreshes the build, then finishes", async () => {
    const session = memorySession();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responsesReply([
          { type: "function_call", call_id: "call_1", name: "bash", arguments: JSON.stringify({ command: "build" }) },
        ]),
      )
      .mockResolvedValueOnce(
        responsesReply([{ type: "message", content: [{ type: "output_text", text: "done" }] }]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const e of agentTurn(session, "key", "hi")) events.push(e);

    expect(events.some((e) => e.type === "build")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second request replays the function call plus its output.
    const secondCall = fetchMock.mock.calls[1];
    if (!secondCall) throw new Error("expected a second model request");
    const secondBody = JSON.parse(secondCall[1].body);
    expect(secondBody.model).toBe("muse-spark-1.3");
    expect(secondBody.input).toContainEqual(
      expect.objectContaining({ type: "function_call", call_id: "call_1" }),
    );
    expect(secondBody.input).toContainEqual(
      expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
    );
  });

  it("writes a file then finishes", async () => {
    const session = memorySession();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          responsesReply([
            {
              type: "function_call",
              call_id: "call_1",
              name: "write_file",
              arguments: JSON.stringify({ path: "server/index.ts", content: "v2" }),
            },
          ]),
        )
        .mockResolvedValueOnce(
          responsesReply([{ type: "message", content: [{ type: "output_text", text: "done" }] }]),
        ),
    );

    const events = [];
    for await (const e of agentTurn(session, "key", "hi")) events.push(e);

    expect(session.files["server/index.ts"]).toBe("v2");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("refuses an unsafe write_file path", async () => {
    const session = memorySession();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          responsesReply([
            {
              type: "function_call",
              call_id: "call_1",
              name: "write_file",
              arguments: JSON.stringify({ path: "../evil.ts", content: "x" }),
            },
          ]),
        )
        .mockResolvedValueOnce(
          responsesReply([{ type: "message", content: [{ type: "output_text", text: "refused, sorry" }] }]),
        ),
    );

    const events = [];
    for await (const e of agentTurn(session, "key", "pwn")) events.push(e);

    expect(session.files["server/index.ts"]).toBe("v1");
    expect("evil.ts" in session.files).toBe(false);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0]).toMatchObject({ ok: false });
  });

  it("hints at the browser-stored key on 401", async () => {
    const session = memorySession();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("bad key", { status: 401 })));

    const events = [];
    for await (const e of agentTurn(session, "key", "hi")) events.push(e);

    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect((events.at(-1) as { message: string }).message).toContain("401");
  });

  it("sends the go gateway model to the go endpoint", async () => {
    const session = memorySession();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responsesReply([{ type: "message", content: [{ type: "output_text", text: "done" }] }]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const e of agentTurn(session, "key", "hi", {
      gateway: "go",
      model: "muse-spark-1.3-contributor",
    }))
      events.push(e);

    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).model).toBe("muse-spark-1.3-contributor");
  });

  it("sends x-opencode-session and user-agent so Go can route the request", async () => {
    const session = memorySession();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responsesReply([
          { type: "function_call", call_id: "call_1", name: "bash", arguments: JSON.stringify({ command: "build" }) },
        ]),
      )
      .mockResolvedValueOnce(
        responsesReply([{ type: "message", content: [{ type: "output_text", text: "done" }] }]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const e of agentTurn(session, "key", "hi", {
      gateway: "go",
      model: "muse-spark-1.3-contributor",
      sessionId: "sess-123",
    }))
      events.push(e);

    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const headers = call[1].headers;
      expect(headers["x-opencode-session"]).toBe("sess-123");
      expect(headers["user-agent"]).toBe("app-builder/0.1.0");
    }
  });

  it("falls back to the gateway default for an unknown model", async () => {
    const session = memorySession();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responsesReply([{ type: "message", content: [{ type: "output_text", text: "done" }] }]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const e of agentTurn(session, "key", "hi", { gateway: "zen", model: "nope-free" }))
      events.push(e);

    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).model).toBe("muse-spark-1.3");
  });

  it("yields an error instead of hanging when the model stalls", async () => {
    const session = memorySession();
    // Behaves like real fetch: rejects once the abort signal fires.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation timed out", "TimeoutError")),
            );
          }),
      ),
    );

    const events = [];
    for await (const e of agentTurn(session, "key", "hi", { timeoutMs: 20 })) events.push(e);

    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect((events.at(-1) as { message: string }).message).toMatch(/timed out/);
    // The transcript is persisted so a retry continues from intact history.
    expect(await session.getMessages()).toContainEqual(
      expect.objectContaining({ role: "user", content: "hi" }),
    );
  });
});
