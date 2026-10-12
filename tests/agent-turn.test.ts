import { afterEach, describe, expect, it, vi } from "vitest";
import { agentTurn, MAX_OUTPUT_TOKENS, withToolTimeout, type SessionApi } from "../src/agent";
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

  it("feeds TypeScript errors back to the model after write_file", async () => {
    const session = memorySession();
    session.build = async (f?: FileMap) => ({
      ok: true,
      tables: ["todos"],
      queries: {},
      logs: [],
      durationMs: 1,
      files: f ?? session.files,
      diagnostics: [
        {
          code: 2339,
          category: "error" as const,
          text: "Property 'patch' does not exist.",
          file: "server/index.ts",
          line: 41,
          column: 26,
          endLine: 41,
          endColumn: 31,
          sourceLines: [],
          related: [],
        },
      ],
    });
    const fetchMock = vi
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
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const e of agentTurn(session, "key", "hi")) events.push(e);

    // The preview stays live: the build (with its type verdict) is emitted.
    const builds = events.filter((e) => e.type === "build");
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({ result: { diagnostics: expect.any(Array) } });
    // The model's next request carries the TS error in the tool output.
    const secondCall = fetchMock.mock.calls[1];
    if (!secondCall) throw new Error("expected a second model request");
    const secondBody = JSON.parse(secondCall[1].body);
    const toolOutput = secondBody.input.find(
      (i: any) => i?.type === "function_call_output" && i?.call_id === "call_1",
    );
    expect(toolOutput?.output).toContain("wrote server/index.ts");
    expect(toolOutput?.output).toContain("type errors:");
    expect(toolOutput?.output).toContain("error TS2339");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("feeds TypeScript errors back to the model after bash build", async () => {
    const session = memorySession();
    session.build = async (f?: FileMap) => ({
      ok: true,
      tables: ["todos"],
      queries: {},
      logs: [],
      durationMs: 1,
      files: f ?? session.files,
      diagnostics: [
        {
          code: 2339,
          category: "error" as const,
          text: "Property '_id' does not exist.",
          file: "server/index.ts",
          line: 64,
          column: 49,
          endLine: 64,
          endColumn: 53,
          sourceLines: [],
          related: [],
        },
      ],
    });
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
    const secondCall = fetchMock.mock.calls[1];
    if (!secondCall) throw new Error("expected a second model request");
    const secondBody = JSON.parse(secondCall[1].body);
    const toolOutput = secondBody.input.find(
      (i: any) => i?.type === "function_call_output" && i?.call_id === "call_1",
    );
    expect(toolOutput?.output).toContain("type errors:");
    expect(toolOutput?.output).toContain("error TS2339");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("rebuilds and reports when the shell itself changed files", async () => {
    const session = memorySession();
    let builds = 0;
    const innerBuild = session.build;
    session.build = async (f?: FileMap) => {
      builds++;
      return innerBuild(f);
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responsesReply([
          {
            type: "function_call",
            call_id: "call_1",
            name: "bash",
            // Not a dev-cycle command, but the stub shell writes a file.
            arguments: JSON.stringify({ command: "echo write hi > server/note.txt && write done" }),
          },
        ]),
      )
      .mockResolvedValueOnce(
        responsesReply([{ type: "message", content: [{ type: "output_text", text: "done" }] }]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const e of agentTurn(session, "key", "hi")) events.push(e);

    expect(builds).toBe(1);
    expect(events.some((e) => e.type === "build")).toBe(true);
    const secondCall = fetchMock.mock.calls[1];
    if (!secondCall) throw new Error("expected a second model request");
    const secondBody = JSON.parse(secondCall[1].body);
    const toolOutput = secondBody.input.find(
      (i: any) => i?.type === "function_call_output" && i?.call_id === "call_1",
    );
    expect(toolOutput?.output).toContain("build passed");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("edits server then client across rounds instead of stalling", async () => {
    const session = memorySession({
      "server/index.ts": "v1",
      "client/index.tsx": "c1",
    });
    const fetchMock = vi
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
        responsesReply([
          {
            type: "function_call",
            call_id: "call_2",
            name: "write_file",
            arguments: JSON.stringify({ path: "client/index.tsx", content: "c2" }),
          },
        ]),
      )
      .mockResolvedValueOnce(
        responsesReply([{ type: "message", content: [{ type: "output_text", text: "done" }] }]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const e of agentTurn(session, "key", "hi")) events.push(e);

    expect(session.files["server/index.ts"]).toBe("v2");
    expect(session.files["client/index.tsx"]).toBe("c2");
    expect(events.filter((e) => e.type === "build")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("times out a hung build instead of wedging the turn", async () => {
    const session = memorySession();
    session.build = () => new Promise<any>(() => {});
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
    for await (const e of agentTurn(session, "key", "hi", { toolTimeoutMs: 20 })) events.push(e);

    // The file is still saved; the timeout is reported in the tool output.
    expect(session.files["server/index.ts"]).toBe("v2");
    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0]?.detail ?? "").toMatch(/timed out/i);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("times out a hung shell command instead of wedging the turn", async () => {
    const session = memorySession();
    session.exec = () => new Promise<any>(() => {});
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          responsesReply([
            { type: "function_call", call_id: "call_1", name: "bash", arguments: JSON.stringify({ command: "build" }) },
          ]),
        )
        .mockResolvedValueOnce(
          responsesReply([{ type: "message", content: [{ type: "output_text", text: "done" }] }]),
        ),
    );

    const events = [];
    for await (const e of agentTurn(session, "key", "hi", { toolTimeoutMs: 20 })) events.push(e);

    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0]).toMatchObject({ ok: false });
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("requests enough output tokens for full-file rewrites", async () => {
    const session = memorySession();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responsesReply([{ type: "message", content: [{ type: "output_text", text: "done" }] }]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const e of agentTurn(session, "key", "hi")) events.push(e);

    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).max_output_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThan(2048);
  });

  it("withToolTimeout rejects a hung promise", async () => {
    await expect(withToolTimeout(new Promise(() => {}), 10, "build")).rejects.toThrow(/timed out/);
  });
});
