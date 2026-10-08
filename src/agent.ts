/**
 * The agent loop.
 *
 * Calls the OpenCode Zen API with `space-bunny-free` and gives it five tools
 * over the session's files. Runs inside the Worker: the loop is almost entirely
 * waiting on the API, and waiting on network does not count toward CPU time, so
 * the 10ms budget is not a constraint. The QuickJS sandbox it builds against
 * lives in the Durable Object, because that has to persist.
 */

import type { ChatMessage, FileMap, ToolCall } from "./session";
import type { RunResult } from "./sandbox";

export const ZEN_BASE = "https://opencode.ai/zen/v1";
export const MODEL = "space-bunny-free";

const MAX_TOOL_ROUNDS = 12;

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "tool_result"; name: string; ok: boolean; detail: string }
  | { type: "build"; result: RunResult & { files: FileMap } }
  | { type: "done"; messages: ChatMessage[]; files: FileMap }
  | { type: "error"; message: string };

export type SessionApi = {
  getFiles: () => Promise<FileMap>;
  setFiles: (files: FileMap) => Promise<void>;
  getMessages: () => Promise<ChatMessage[]>;
  setMessages: (messages: ChatMessage[]) => Promise<void>;
  build: (files?: FileMap) => Promise<RunResult & { files: FileMap }>;
};

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description: "List the files in the project.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a file's current contents.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path, e.g. index.ts" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description:
        "Create or overwrite a file. This is the only way to change the app. Write complete file contents, not a diff.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, e.g. index.ts" },
          content: { type: "string", description: "The full new contents of the file" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "build",
      description:
        "Compile and run the project, then report console output, rendered HTML, or the error. Call this after writing files to check your work.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_logs",
      description: "Read the console output from the most recent build.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const SYSTEM = `You are the build agent for a small web app that runs inside a Cloudflare Worker.

The app's source is TypeScript, executed in a QuickJS VM compiled to WebAssembly.

The file \`index.ts\` is the whole app. Available in it:
- \`html\` — a tagged template that renders output. It appends, so call it once with all the markup.
- \`state\` — a plain object that persists between builds, in the same isolate.
- \`console.log/warn/error\` — captured and shown to you.

Language support is narrower than browsers:
- No npm imports. No DOM. The only globals are the three above.
- \`await\` only works for values that already settled. Never await a timer or real I/O.
- No \`while\` loops that run unbounded; keep work small.

Work by editing \`index.ts\`, then calling \`build\` to check the result. If the build reports an error, read it and fix the cause. Finish by describing what you changed in one or two sentences.`;

type ToolResult = { role: "tool"; tool_call_id: string; name: string; content: string };

export type Stream = AsyncGenerator<AgentEvent>;

/**
 * Run one turn: send the user's message, execute whatever tools the model asks
 * for, and repeat until it answers in prose or the round budget runs out.
 */
export async function* agentTurn(
  session: SessionApi,
  apiKey: string,
  userMessage: string,
): Stream {
  let files = await session.getFiles();
  let messages = await session.getMessages();
  messages.push({ role: "user", content: userMessage });
  await session.setMessages(messages);

  let lastBuild: (RunResult & { files: FileMap }) | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(`${ZEN_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM }, ...messages],
        tools: TOOLS,
        tool_choice: "auto",
        max_tokens: 2048,
      }),
    });

    if (!res.ok) {
      yield { type: "error", message: `model request failed: ${res.status} ${await res.text()}` };
      return;
    }

    const body: any = await res.json();
    const choice = body?.choices?.[0];
    if (!choice) {
      yield { type: "error", message: "model returned no choices" };
      return;
    }

    const msg = choice.message ?? {};
    const content: string = msg.content ?? "";
    if (content) {
      messages.push({ role: "assistant", content });
      yield { type: "text", text: content };
    }

    const calls: ToolCall[] = msg.tool_calls ?? [];
    if (calls.length === 0) {
      await session.setMessages(messages);
      yield { type: "done", messages, files };
      return;
    }

    // The assistant turn has to carry its tool_calls forward. The API pairs
    // each one with a following role:"tool" message by id, and rejects the
    // request if the array is missing.
    messages.push({
      role: "assistant",
      content: content ?? "",
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.function.name, arguments: c.function.arguments },
      })),
    });

    for (const call of calls) {
      const name: string = call.function?.name ?? "";
      let args: any = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }

      yield { type: "tool", name, detail: describe(name, args) };

      let out: string;
      let ok = true;

      switch (name) {
        case "list_files": {
          files = await session.getFiles();
          out = Object.keys(files).join("\n") || "(empty)";
          break;
        }
        case "read_file": {
          files = await session.getFiles();
          const path = String(args.path ?? "");
          if (!(path in files)) {
            ok = false;
            out = `no such file: ${path}. Known: ${Object.keys(files).join(", ")}`;
          } else {
            out = files[path];
          }
          break;
        }
        case "write_file": {
          const path = String(args.path ?? "").trim() || "index.ts";
          if (!/^[\w./-]+$/.test(path) || path.includes("..")) {
            ok = false;
            out = `refusing unsafe path: ${path}`;
          } else {
            files = { ...(await session.getFiles()), [path]: String(args.content ?? "") };
            await session.setFiles(files);
            out = `wrote ${path} (${String(args.content ?? "").length} chars)`;
          }
          break;
        }
        case "build": {
          lastBuild = await session.build(files);
          yield { type: "build", result: lastBuild };
          out = buildFeedback(lastBuild);
          ok = lastBuild.ok;
          break;
        }
        case "read_logs": {
          out = lastBuild
            ? lastBuild.logs.join("\n") || "(no console output)"
            : "no build yet — call build first";
          break;
        }
        default:
          ok = false;
          out = `unknown tool: ${name}`;
      }

      const result: ToolResult = {
        role: "tool",
        tool_call_id: call.id,
        name,
        content: out.slice(0, 8000),
      };
      messages.push(result);
      yield { type: "tool_result", name, ok, detail: result.content.slice(0, 400) };
    }

    await session.setMessages(messages);
  }

  yield {
    type: "error",
    message: `stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer`,
  };
}

function describe(name: string, args: any): string {
  switch (name) {
    case "write_file":
      return args.path ? `write ${args.path}` : "write";
    case "read_file":
      return args.path ? `read ${args.path}` : "read";
    case "build":
      return "build";
    default:
      return name.replace(/_/g, " ");
  }
}

/** Turn a build result into the feedback an agent can act on. */
export function buildFeedback(result: RunResult): string {
  const parts: string[] = [];
  if (result.compileError) parts.push(`TypeScript failed to parse: ${result.compileError.message}`);
  if (result.typecheckError) {
    parts.push(
      `Type checker failed: ${result.typecheckError.name}: ${result.typecheckError.message}` +
        (result.typecheckError.stderr ? `\nstderr:\n${result.typecheckError.stderr}` : ""),
    );
  }
  if (result.diagnostics?.length) {
    parts.push(
      `Type check failed with ${result.diagnostics.length} error(s):\n` +
        result.diagnostics
          .map((d) => `${d.file}(${d.line},${d.column}): error TS${d.code}: ${d.text}`)
          .join("\n"),
    );
  }
  if (result.error) parts.push(`${result.error.name}: ${result.error.message}`);
  if (result.logs.length) parts.push(`console:\n${result.logs.join("\n")}`);
  if (result.ok && !result.compileError) {
    parts.push(`build passed in ${result.durationMs}ms. Rendered ${result.html.length} chars.`);
  }
  return parts.join("\n") || "build finished with no output";
}