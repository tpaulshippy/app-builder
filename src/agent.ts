/**
 * The agent loop.
 *
 * Calls the OpenCode Responses endpoint (`zen` or `go` gateway, paid models
 * only — free `*-free` models 403 outside the OpenCode client) and gives it
 * a just-bash-backed shell plus file helpers. Runs inside the
 * Worker: the loop is almost entirely waiting on the API, and waiting on
 * network does not count toward CPU time, so the 10ms budget is not a
 * constraint. The capsule runtime it builds against lives in the Durable
 * Object, because that has to persist.
 *
 * Auth is BYOK: the browser holds the caller's key in localStorage and sends
 * it with each chat request. The Worker never stores it; `OPENCODE_ZEN_KEY`
 * remains only as a server-side fallback.
 */

import type { CapsuleResult } from "./capsule";
import type { ChatMessage, BuildResult, FileMap, ToolCall } from "./session";
import { isSafePath } from "./paths";

export const ZEN_BASE = "https://opencode.ai/zen/v1";

export const GO_BASE = "https://opencode.ai/zen/go/v1";

export const RESPONSES_URL = `${ZEN_BASE}/responses`;

/** Distinctive client name so Go can tell this app apart from generic fetch. */
export const USER_AGENT = "app-builder/0.1.0";

export type Gateway = "zen" | "go";

/**
 * Paid models compatible with the Responses endpoint this agent calls.
 * Free `*-free` preview models are deliberately excluded: Zen rejects them
 * with `FreeTierError` outside the OpenCode client.
 */
export const ZEN_MODELS = [
  "muse-spark-1.3",
  "muse-spark-1.2",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-nano",
  "grok-4.7",
  "grok-4.6",
  "grok-4.5",
  "grok-build-0.1",
] as const;

/** Paid Go models on the Responses endpoint (free previews excluded). */
export const GO_MODELS = [
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor",
  "gpt-6-luna",
  "gpt-5.6-luna",
  "grok-4.7",
  "grok-4.6",
] as const;

export const DEFAULT_GATEWAY: Gateway = "zen";
export const DEFAULT_MODEL = "muse-spark-1.3";
/** Previous default; kept so existing transcripts stay readable. */
export const MODEL = DEFAULT_MODEL;

export function gatewayBase(gateway: Gateway): string {
  return gateway === "go" ? GO_BASE : ZEN_BASE;
}

export function responsesUrl(gateway: Gateway): string {
  return `${gatewayBase(gateway)}/responses`;
}

export function isGateway(value: unknown): value is Gateway {
  return value === "zen" || value === "go";
}

export function modelsFor(gateway: Gateway): readonly string[] {
  return gateway === "go" ? GO_MODELS : ZEN_MODELS;
}

export function defaultModelFor(gateway: Gateway): string {
  return gateway === "go" ? GO_MODELS[0] : ZEN_MODELS[0];
}

export function isModelFor(gateway: Gateway, model: unknown): boolean {
  return typeof model === "string" && (modelsFor(gateway) as readonly string[]).includes(model);
}

export const MAX_TOOL_ROUNDS = 20;

/** Per model request: a stalled gateway must fail the turn, not spin forever. */
export const MODEL_TIMEOUT_MS = 60_000;

/** Per tool execution: a hung build/shell must fail visibly, not wedge the SSE stream. */
export const TOOL_TIMEOUT_MS = 90_000;

/** Output budget: a full client rewrite does not fit in 2048 tokens. */
export const MAX_OUTPUT_TOKENS = 8192;

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "tool_result"; name: string; ok: boolean; detail: string }
  | { type: "build"; result: BuildResult }
  | { type: "done"; messages: ChatMessage[]; files: FileMap }
  | { type: "error"; message: string };

export type SessionApi = {
  getFiles: () => Promise<FileMap>;
  setFiles: (files: FileMap) => Promise<void>;
  getMessages: () => Promise<ChatMessage[]>;
  setMessages: (messages: ChatMessage[]) => Promise<void>;
  build: (files?: FileMap) => Promise<BuildResult>;
  exec: (
    command: string,
    files?: FileMap,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number; files: FileMap }>;
};

const TOOLS = [
  {
    type: "function" as const,
    name: "bash",
    description:
      "Run a bash command in the capsule workspace (/app). Use ls/cat/grep/sed/jq to inspect, and the custom commands build, tests, lint, deploy to check and publish your work. Always run build after editing, and tests + lint before deploy.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The bash command, e.g. ls server && build" } },
      required: ["command"],
    },
  },
  {
    type: "function" as const,
    name: "read_file",
    description: "Read a file's current contents without shell quoting.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File path, e.g. server/index.ts" } },
      required: ["path"],
    },
  },
  {
    type: "function" as const,
    name: "write_file",
    description:
      "Create or overwrite a file. This is the usual way to change the app. Write complete file contents, not a diff.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, e.g. server/index.ts" },
        content: { type: "string", description: "The full new contents of the file" },
      },
      required: ["path", "content"],
    },
  },
];

const SYSTEM = `You are the build agent for a small full-stack app (a Lakebed capsule) that runs inside a Cloudflare Worker.

The capsule source is TypeScript, executed against an in-memory database with lakebed-dev semantics:

- \`server/index.ts\` exports the default \`capsule()\` definition: schema (tables with \`table()\`, indexes with \`.index()\`), \`queries\`, \`mutations\`, \`actions\`, \`endpoints\`. Import from \`lakebed/server\`.
- \`client/index.tsx\` exports \`App\` (Preact). Import from \`lakebed/client\`, \`preact\`, or relative files.
- \`shared/\` is pure TypeScript used by both sides.
- Database calls are async: \`withIndex(name, (q) => q.eq(field, value))\`, then \`order("asc"|"desc")\` and \`collect() | take(n) | first() | paginate()\`. Use \`by_creation\` for unfiltered order.
- Gate user data with \`ctx.auth.requireIdentity()\` and filter by its \`userId\`.

Language support is narrower than browsers or Node:
- Only relative files, \`lakebed/*\`, and \`preact\`. No npm installs, no Node built-ins.
- \`await\` only works for values that already settle. Never await a timer or real I/O.
- No \`while\` loops, C-style \`for(;;)\`, \`eval\`, dynamic \`import()\`, or server-side \`fetch\` (anonymous deploys disable it).

Work in the shell: list files, edit with \`write_file\`, then run \`build\` to check the result. Run \`tests\` and \`lint\` before \`deploy\`. Do not create probe files to explore the API — use the documented calls above. A full-stack change needs both sides: after writing \`server/index.ts\`, read and update \`client/index.tsx\` before finishing. If a command or file write reports an error (including TypeScript errors), read it and fix the cause before moving on. Finish by describing what you changed in one or two sentences, including the deploy URL when you deployed.`;

export type Stream = AsyncGenerator<AgentEvent>;

/**
 * Race a tool promise against a timeout so a hung build/shell fails the
 * tool visibly instead of wedging the SSE stream after the last edit.
 * The Durable Object keeps running in the background; the turn stays alive
 * so the agent can still move on (e.g. to the client) on the next round.
 */
export function withToolTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms — progress is saved, retry your message`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** Persisted transcript -> Responses input items. */
function historyInput(messages: ChatMessage[]): any[] {
  const input: any[] = [];
  for (const m of messages) {
    if (m.role === "user") input.push({ role: "user", content: m.content });
    else if (m.role === "assistant" && m.tool_calls?.length) {
      for (const c of m.tool_calls) {
        input.push({ type: "function_call", call_id: c.call_id, name: c.name, arguments: c.arguments });
      }
    } else if (m.role === "assistant") input.push({ role: "assistant", content: m.content });
    else if (m.role === "tool" && m.tool_call_id) {
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content });
    }
  }
  return input;
}

function outputText(item: any): string {
  if (item.type !== "message" || !Array.isArray(item.content)) return "";
  return item.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("");
}

/**
 * Run one turn: send the user's message, execute whatever tools the model asks
 * for, and repeat until it answers in prose or the round budget runs out.
 */
export async function* agentTurn(
  session: SessionApi,
  apiKey: string,
  userMessage: string,
  opts?: { gateway?: unknown; model?: unknown; sessionId?: unknown; timeoutMs?: unknown; toolTimeoutMs?: unknown },
): Stream {
  const gateway: Gateway = isGateway(opts?.gateway) ? opts.gateway : DEFAULT_GATEWAY;
  const model = isModelFor(gateway, opts?.model) ? String(opts?.model) : defaultModelFor(gateway);
  const url = responsesUrl(gateway);
  // Test and harness override; production uses MODEL_TIMEOUT_MS.
  const timeoutMs =
    typeof opts?.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : MODEL_TIMEOUT_MS;
  const toolTimeoutMs =
    typeof opts?.toolTimeoutMs === "number" && opts.toolTimeoutMs > 0 ? opts.toolTimeoutMs : TOOL_TIMEOUT_MS;
  // Go rejects requests without a stable per-conversation session id.
  const sessionId = typeof opts?.sessionId === "string" && opts.sessionId.trim() ? opts.sessionId.trim() : "";
  let files = await session.getFiles();
  const messages = await session.getMessages();
  messages.push({ role: "user", content: userMessage });
  await session.setMessages(messages);
  const input = [...historyInput(messages.slice(0, -1)), { role: "user", content: userMessage }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "user-agent": USER_AGENT,
          ...(sessionId ? { "x-opencode-session": sessionId } : {}),
        },
        body: JSON.stringify({
          model,
          instructions: SYSTEM,
          input,
          tools: TOOLS,
          tool_choice: "auto",
          max_output_tokens: MAX_OUTPUT_TOKENS,
        }),
        // A hung gateway must end the turn with an error, not spin the UI
        // forever: without this the SSE stream stays open and the transcript
        // looks stuck after the last completed tool call.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Persist the transcript so a retry continues from intact history.
      await session.setMessages(messages);
      const timedOut = e instanceof DOMException && e.name === "TimeoutError";
      yield {
        type: "error",
        message: timedOut
          ? `model request timed out after ${timeoutMs}ms — retry your message`
          : `model request failed: ${e instanceof Error ? e.message : String(e)}`,
      };
      return;
    }

    if (!res.ok) {
      const hint =
        res.status === 401
          ? " (check the API key — it is stored in this browser's local storage)"
          : res.status === 429
            ? " (rate limited — wait and try again)"
            : "";
      yield { type: "error", message: `model request failed: ${res.status} ${await res.text()}${hint}` };
      return;
    }

    const body: any = await res.json();
    const items: any[] = body?.output ?? [];
    if (!items.length) {
      yield { type: "error", message: "model returned no output" };
      return;
    }

    const text = items.map(outputText).join("");
    if (text) {
      messages.push({ role: "assistant", content: text });
      yield { type: "text", text };
    }

    const calls: ToolCall[] = items
      .filter((i) => i?.type === "function_call")
      .map((i) => ({ call_id: i.call_id, name: i.name, arguments: i.arguments ?? "{}" }));
    if (calls.length === 0) {
      await session.setMessages(messages);
      yield { type: "done", messages, files };
      return;
    }

    // Replay the raw output items so the next request carries the tool calls.
    input.push(...items);
    messages.push({
      role: "assistant",
      content: text,
      tool_calls: calls.map((c) => ({ call_id: c.call_id, name: c.name, arguments: c.arguments })),
    });

    for (const call of calls) {
      const name: string = call.name ?? "";
      let args: any = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        args = {};
      }

      yield { type: "tool", name, detail: describe(name, args) };

      let out: string;
      let ok = true;

      switch (name) {
        case "bash": {
          const command = String(args.command ?? "");
          const before = files;
          let r: { stdout: string; stderr: string; exitCode: number; files: FileMap };
          try {
            r = await withToolTimeout(session.exec(command, files), toolTimeoutMs, "shell command");
          } catch (e) {
            // A hung shell must not wedge the turn: report it and let the
            // next round move on (e.g. to the client edit).
            await session.setMessages(messages);
            out = `$ ${command}\nbuild check failed: ${e instanceof Error ? e.message : String(e)}`;
            ok = false;
            yield { type: "tool_result", name, ok, detail: out.slice(0, 400) };
            break;
          }
          files = r.files;
          const head = `$ ${command}\n`;
          out = head + (r.stdout || "") + (r.stderr ? `\nstderr:\n${r.stderr}` : "") + `\n(exit ${r.exitCode})`;
          ok = r.exitCode === 0;
          // Keep the preview live when the agent ran the dev cycle, and make
          // sure TypeScript errors reach the model: session.build() carries
          // the ts-rust verdict, while the shell's own `build` output does
          // not (sucrase strips types without checking them). The same
          // applies when the shell itself changed files (redirections, sed).
          const isDevCycle = /\b(build|tests|lint|deploy)\b/.test(command);
          if (isDevCycle || !sameFiles(before, files)) {
            try {
              const built = await withToolTimeout(session.build(files), toolTimeoutMs, "build");
              if (built.files) files = built.files;
              yield { type: "build", result: built };
              const feedback = buildFeedback(built);
              // Reserve room so the verdict survives long shell output.
              out = `${out.slice(0, 6000)}\n${feedback}`;
              ok = ok && built.ok;
            } catch (e) {
              out += `\nbuild check failed: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
          yield { type: "tool_result", name, ok, detail: out.slice(0, 400) };
          break;
        }
        case "read_file": {
          files = await session.getFiles();
          const path = String(args.path ?? "");
          const contents = path in files ? files[path] : undefined;
          if (contents === undefined) {
            ok = false;
            out = `no such file: ${path}. Known: ${Object.keys(files).join(", ")}`;
          } else {
            out = contents;
          }
          break;
        }
        case "write_file": {
          const path = String(args.path ?? "").trim();
          if (!path || !isSafePath(path)) {
            ok = false;
            out = `refusing unsafe path: ${path || "(empty)"}`;
          } else {
            files = { ...(await session.getFiles()), [path]: String(args.content ?? "") };
            await session.setFiles(files);
            // Report the build (including the ts-rust type verdict) back to
            // the model: sucrase strips types without checking them, so
            // without this a type error is invisible until lint/deploy.
            try {
              const built = await withToolTimeout(session.build(files), toolTimeoutMs, "build");
              if (built.files) files = built.files;
              yield { type: "build", result: built };
              out = `wrote ${path} (${String(args.content ?? "").length} chars)\n${buildFeedback(built)}`;
              ok = built.ok;
            } catch (e) {
              out = `wrote ${path} (${String(args.content ?? "").length} chars)\nbuild check failed: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
          break;
        }
        default:
          ok = false;
          out = `unknown tool: ${name}`;
      }

      if (name !== "bash") {
        yield { type: "tool_result", name, ok, detail: out.slice(0, 400) };
      }
      const content = out.slice(0, 8000);
      input.push({ type: "function_call_output", call_id: call.call_id, output: content });
      messages.push({ role: "tool", content, name, tool_call_id: call.call_id });
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
    case "bash":
      return args.command ? `$ ${String(args.command).slice(0, 80)}` : "shell";
    case "write_file":
      return args.path ? `write ${args.path}` : "write";
    case "read_file":
      return args.path ? `read ${args.path}` : "read";
    default:
      return name.replace(/_/g, " ");
  }
}

/** Turn capsule diagnostics into tsc-shaped feedback an agent can act on. */
export function formatDiagnostics(diagnostics: { file: string; line: number; column: number; code: number; category: string; text: string }[]): string {
  // Report what the checker actually said: the category (a warning is not an
  // error) and no TS code when there is none — `TS0` would send the agent
  // chasing a code that does not exist.
  return diagnostics
    .map((d) => `${d.file}(${d.line},${d.column}): ${d.category}${d.code ? ` TS${d.code}` : ""}: ${d.text}`)
    .join("\n");
}

/** Turn a capsule build result into the feedback an agent can act on. */
export function buildFeedback(
  result: CapsuleResult & {
    diagnostics?: { file: string; line: number; column: number; code: number; category: string; text: string }[];
    typecheckFailure?: { name: string; message: string };
  },
): string {
  const parts: string[] = [];
  if (result.error) parts.push(`${result.error.name}: ${result.error.message}`);
  if (result.logs.length) parts.push(`console:\n${result.logs.join("\n")}`);
  if (result.ok) {
    parts.push(`build passed in ${result.durationMs}ms. Tables: ${result.tables.join(", ") || "(none)"}.`);
    for (const [name, rows] of Object.entries(result.queries)) {
      parts.push(`query ${name}: ${JSON.stringify(rows)}`);
    }
  }
  if (result.typecheckFailure) {
    parts.push(
      `type checker did not finish (${result.typecheckFailure.name}): ${result.typecheckFailure.message}`,
    );
  } else if (result.diagnostics?.length) {
    parts.push(`type errors:\n${formatDiagnostics(result.diagnostics)}`);
  }
  return parts.join("\n") || "build finished with no output";
}

/** True when two file maps hold the same paths with the same contents. */
function sameFiles(a: FileMap, b: FileMap): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (a[ka[i] as string] !== b[kb[i] as string]) return false;
  }
  return true;
}
