/**
 * Shared agent contract: gateway/model catalog (OpenCode `zen` or `go`,
 * paid models only — free `*-free` models 403 outside the OpenCode
 * client), the system prompt, the SSE event stream, the session API the
 * tools run against, and build-feedback formatting.
 *
 * The turn loop itself lives in Pi (pi-durable PiHarness in the Durable
 * Object); this module no longer calls any model endpoint.
 *
 * Auth is BYOK: the browser holds the caller's key in localStorage and sends
 * it with each chat request. The Worker secret `OPENCODE_ZEN_KEY` remains
 * only as a server-side fallback.
 */

import type { CapsuleResult } from "./capsule";
import type { ChatMessage, BuildResult, FileMap } from "./session";

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

/** Per model request: a stalled gateway must fail the turn, not spin forever. */
export const MODEL_TIMEOUT_MS = 60_000;

/** Per tool execution: a hung build/shell must fail visibly, not wedge the SSE stream. */
export const TOOL_TIMEOUT_MS = 90_000;

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
  gitStatus?: () => Promise<string>;
  gitLog?: () => Promise<string>;
  gitRun?: (command: string) => Promise<{ ok: boolean; stdout: string; stderr: string; files: FileMap }>;
};

export const SYSTEM = `You are the build agent for a small full-stack app (a Lakebed capsule) that runs inside a Cloudflare Worker.

The capsule source is TypeScript, executed against an in-memory database with lakebed-dev semantics:

- \`server/index.ts\` exports the default \`capsule()\` definition: schema (tables with \`table()\`, indexes with \`.index()\`), \`queries\`, \`mutations\`, \`actions\`, \`endpoints\`. Import from \`lakebed/server\`.
- \`client/index.tsx\` exports \`App\` (Preact). Import from \`lakebed/client\`, \`preact\`, or relative files.
- \`shared/\` is pure TypeScript used by both sides.
- Database calls are async: \`withIndex(name, (q) => q.eq(field, value))\`, then \`order("asc"|"desc")\` and \`collect() | take(n) | first() | paginate()\`. Use \`by_creation\` for unfiltered order.
- Gate user data with \`ctx.auth.requireIdentity()\` and filter by its \`userId\`.
- Client layout must fit a 375px iPhone with no horizontal scrolling: fluid widths
  (\`max-width:100%\`), \`flex-wrap:wrap\` with \`min-width:0\` on flex children, no fixed
  pixel widths over ~300px, and inputs at 16px+ so iOS does not auto-zoom.

Language support is narrower than browsers or Node:
- Only relative files, \`lakebed/*\`, and \`preact\`. No npm installs, no Node built-ins.
- \`await\` only works for values that already settle. Never await a timer or real I/O.
- No \`while\` loops, C-style \`for(;;)\`, \`eval\`, dynamic \`import()\`, or server-side \`fetch\` (anonymous deploys disable it).

 Work in the shell: list files, edit with \`write_file\`, then run \`build\` to check the result. Run \`tests\` and \`lint\` before \`deploy\`. Do not create probe files to explore the API — use the documented calls above. A full-stack change needs both sides: after writing \`server/index.ts\`, read and update \`client/index.tsx\` before finishing. If a command or file write reports an error (including TypeScript errors), read it and fix the cause before moving on. Finish by describing what you changed in one or two sentences, including the deploy URL when you deployed.`;

/** Git paragraph: appended to SYSTEM only where git tools are offered. */
export const SYSTEM_GIT = `
 The session may have a linked GitHub repo (just-git, server-side). Some repos are not previewable here (no runnable capsule): keep editing files and use the git tools anyway.

 Git tools: git_status, git_log, and git (args after \`git\`, e.g. \`diff --stat\`). The git tool may push, but only fast-forward pushes to the already-linked repo — history rewrites (reset, rebase, force push) are rejected server-side. Creating/opening repos happens in the GitHub panel, not through the tools.`;



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
