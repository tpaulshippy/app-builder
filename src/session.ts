import { DurableObject } from "cloudflare:workers";
import { createSandbox, type RunResult } from "./sandbox";
import { createTypeChecker, peakMiB } from "./typecheck";

/** A tool call as the chat-completions API represents one. */
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  /**
   * Present on assistant turns that requested tools. The API requires these to
   * be replayed verbatim on the next request, each paired with a following
   * `role: "tool"` message, or it rejects the conversation.
   */
  tool_calls?: ToolCall[];
  name?: string;
  tool_call_id?: string;
};

export type FileMap = Record<string, string>;

const FILES_KEY = "files";
const MESSAGES_KEY = "messages";

export const DEFAULT_FILE = `// index.ts — the agent edits this file.
// \`state\` persists between runs, in the same isolate. \`html\` renders output.

state.runs = (state.runs ?? 0) + 1;

interface Task {
  title: string;
  done: boolean;
}

const tasks: Task[] = [
  { title: "Share a read-only board", done: true },
  { title: "A quieter notification inbox", done: false },
];

console.log("build", state.runs, "with", tasks.length, "tasks");

html\`
  <h1>Project board</h1>
  <p class="muted">\${tasks.filter((t) => t.done).length} of \${tasks.length} complete · build \${state.runs}</p>
  <ul>
    \${tasks.map((t) => "<li>" + t.title + "</li>").join("")}
  </ul>
\`;
`;

/**
 * One Durable Object per session: the project's files, its chat history, and one
 * QuickJS runtime that survives across runs and rebuilds.
 *
* The context deliberately outlives individual requests. Re-running with new
 * source replaces the program inside the same VM while globals from the previous
 * run are still there, which is the property this prototype exists to show.
 *
 * Files and messages are persisted to the DO's SQLite storage, so a session
 * survives eviction of the isolate. The in-memory globals of the QuickJS VM do
 * not, which is the one thing that resets when the object is evicted.
 *
 * ## Why the type checker lives here
 *
 * Type checking gates `sandbox.run`, and it runs inside the Durable Object for
 * two reasons. A 4.2 MB module must not be deserialised on the Worker's
 * one-second start-up path, and `ts_rust.wasm` keeps one program per process,
 * so the module is instantiated per run rather than held. Neither cost
 * belongs in the request-handling Worker, which also stays free of the
 * compiler's memory: see the shadow-stack note in `typecheck.ts`.
 */
export class AppSession extends DurableObject {
  private readonly sandbox = createSandbox();
  private readonly typechecker = createTypeChecker();

  /**
   * Tail of the type-check queue. See `serialize`.
   */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Run one type check at a time per session.
   *
   * A Durable Object interleaves events, so two requests for the same session
   * can be inside `runOnce` together. That is not merely wasteful: each
   * `ts_rust.wasm` instance peaks at ~69 MiB of linear memory, two of them in a
   * 128 MiB isolate exhaust the budget, and the runtime answers an over-budget
   * isolate by evicting it — which throws away the QuickJS globals this class
   * exists to hold. So the checks go through a promise chain rather than
   * overlapping.
   *
   * The chain swallows rejections, so one failed check does not poison the
   * queue and wedge every later request for the session.
   */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /**
   * Type check, then execute. Every program path goes through here.
   *
   * The timings are local-development diagnostics, not production
   * measurements. Workers freezes both `Date.now()` and `performance.now()`
   * between I/O events, so on a deployed Worker these deltas are 0 and only
   * `wrangler dev` advances them. They are read from `performance.now()` anyway
   * because it is monotonic, so a number that does move means real elapsed time.
   */
  async run(code: string): Promise<RunResult> {
    return this.serialize(async () => {
      const startedAt = performance.now();

      // Type check first. A program tsc rejects must not reach QuickJS: the point
      // is that a wrong type fails here, loudly, rather than three layers down as
      // `undefined`.
      const checked = await this.typechecker.typecheck(code);
      const typecheckMs = performance.now() - startedAt;

      // A type check costs a fresh 4.7 MB module instantiation per run, and the
      // compiler's peak linear memory is ~69 MiB because `crates/ts_wasm/build.rs`
      // reserves a 32 MiB shadow stack. Both numbers decide whether this can ever
      // move off the build-loop path, and both are only knowable by measuring —
      // under `wrangler dev`, where the clock advances. Structured fields rather
      // than a sentence, so they survive log parsing.
      console.log({
        event: "typecheck",
        ms: typecheckMs,
        instantiateMs: checked.timing?.instantiateMs,
        compileMs: checked.timing?.compileMs,
        peakMiB: Number(peakMiB(checked.timing).toFixed(1)),
        diagnostics: checked.diagnostics.length,
        failed: Boolean(checked.failure),
      });

      // A compiler that did not finish is not a pass. Block the run, and say why,
      // rather than executing unchecked code because the diagnostic list is
      // empty.
      if (checked.failure) {
        return {
          ok: false,
          html: "",
          logs: [],
          typecheckError: checked.failure,
          typecheckMs,
          durationMs: performance.now() - startedAt,
        };
      }

      if (checked.diagnostics.length) {
        return {
          ok: false,
          html: "",
          logs: [],
          diagnostics: checked.diagnostics,
          typecheckMs,
          durationMs: performance.now() - startedAt,
        };
      }

      // The type check is part of what a run costs, so it is reported on the
      // success path too, not only when it rejected the program.
      const result = await this.sandbox.run(code);
      return { ...result, typecheckMs };
    });
  }

  async getFiles(): Promise<FileMap> {
    const stored = await this.ctx.storage.get<FileMap>(FILES_KEY);
    return stored ?? { "index.ts": DEFAULT_FILE };
  }

  async setFiles(files: FileMap): Promise<void> {
    await this.ctx.storage.put(FILES_KEY, files);
  }

  async getMessages(): Promise<ChatMessage[]> {
    return (await this.ctx.storage.get<ChatMessage[]>(MESSAGES_KEY)) ?? [];
  }

  async setMessages(messages: ChatMessage[]): Promise<void> {
    await this.ctx.storage.put(MESSAGES_KEY, messages.slice(-60));
  }

  /**
   * The agent's `build` tool, and what `/api/state` and `/api/file` return.
   *
   * It delegates to `run`, so type checking gates every build in the app rather
   * than only the one endpoint the smoke test happens to call.
   */
  async build(files?: FileMap): Promise<RunResult & { files: FileMap }> {
    const current = files ?? (await this.getFiles());
    const source = current["index.ts"] ?? Object.values(current)[0] ?? "";
    const result = await this.run(source);
    return { ...result, files: current };
  }

  async reset(): Promise<{ files: FileMap; messages: ChatMessage[] }> {
    const files: FileMap = { "index.ts": DEFAULT_FILE };
    await this.ctx.storage.put(FILES_KEY, files);
    await this.ctx.storage.put(MESSAGES_KEY, []);
    return { files, messages: [] };
  }
}