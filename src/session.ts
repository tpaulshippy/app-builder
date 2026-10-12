import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { PiHarness } from "agents/harness/pi";
import { createAgentBash, execWithSync, type FileMap } from "./bash";
import {
  fileKey,
  initAppRuntime,
  isNeedsInit,
  mutateAppRuntime,
  queryAppRuntime,
  type AppKind,
  type AppMutation,
  type AppState,
} from "./app-runtime";
import { DEFAULT_FILES, runCapsule, type CapsuleResult } from "./capsule";
import { buildCapsuleProject } from "./capsule-typecheck";
import type { Sandbox } from "./sandbox";
import { createSandbox } from "./sandbox";
import { createTypeChecker, type Diagnostic, type TypecheckFailure, type TypecheckResult } from "./typecheck";
import type { Bash } from "just-bash";
import type { AgentEvent, SessionApi, Stream } from "./agent";
import { createByokKeyHolder, type ByokKeyHolder } from "./pi-durable-byok";
import { mapPiEvents, openPiHarness, piDefaultsFor, piEntriesToChatMessages } from "./pi-harness";

/** A tool call as the Responses API represents one. */
export type ToolCall = {
  call_id: string;
  name: string;
  arguments: string;
};

export type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  /**
   * Present on assistant turns that requested tools. Replayed verbatim on the
   * next request, each paired with following function outputs, or the API
   * rejects the conversation.
   */
  tool_calls?: ToolCall[];
  name?: string;
  tool_call_id?: string;
  /**
   * Set on tool turns: whether the call failed. The Responses replay in
   * `historyInput` ignores it; the Pi replay reports it as `isError` so
   * failed builds/reads/commands stay errors in subsequent rounds.
   */
  isError?: boolean;
};

const FILES_KEY = "files";
const MESSAGES_KEY = "messages";

export type { FileMap };

/**
 * What Save-and-build (and every other `build()` caller) returns: the
 * capsule run plus the type checker's verdict. `diagnostics` is optional so
 * lightweight `SessionApi` stubs (tests, agent harnesses) stay valid; the
 * real session always sets it, possibly empty.
 */
export type BuildResult = CapsuleResult & {
  files: FileMap;
  diagnostics?: Diagnostic[];
  typecheckFailure?: TypecheckFailure;
};

/**
 * One Durable Object per session: the capsule files, its chat history, one
 * QuickJS runtime, and one just-bash instance. Files and messages persist to
 * the DO's SQLite storage, so a session survives eviction; the in-memory VM
 * and bash state do not, and are re-seeded from storage on next use.
 */
export class AppSession extends DurableObject {
  private readonly sandbox: Sandbox = createSandbox();
  private readonly typechecker = createTypeChecker();
  private bash: Bash | null = null;

  /**
   * Slice (c): PiHarness hosted in this object. The holder carries the
   * caller's browser key (one DO per user); Pi resolves auth per attempt
   * through it (see pi-durable-byok). The factory runs at Pi startup, once
   * per isolate; Lifecycle owns fetch/alarm dispatch and falls through to
   * `onRequest` below.
   */
  private readonly byokHolder: ByokKeyHolder = createByokKeyHolder();
  /** Builds reported by Pi tool executions, drained per batch by the turn loop. */
  private piBuilds: BuildResult[] = [];
  private readonly pi = new PiHarness({
    harness: ({ storage, context }) =>
      openPiHarness(storage, context, {
        holder: this.byokHolder,
        session: this.sessionApi(),
        onBuild: (build) => {
          this.piBuilds.push(build);
        },
      }),
    defaults: { model: { provider: "opencode", id: "muse-spark-1.3" } },
  });
  private readonly lifecycle = Lifecycle.install(this).use(this.pi);

  /**
   * Tail of the type-check queue. Each `ts_rust.wasm` instance peaks at
   * ~69 MiB of linear memory (32 MiB shadow stack), so two overlapping checks
   * in a 128 MiB isolate exhaust it and get the isolate evicted — taking the
   * QuickJS globals with it. Checks go through a promise chain, and the chain
   * swallows rejections so one failed check never wedges later requests.
   */
  private tcQueue: Promise<unknown> = Promise.resolve();

  /**
   * Key of the files the live app runtime was initialized with. Null means
   * "not initialized": files changed, the object reset, or the QuickJS
   * globals were lost to eviction and a query reported back `{needsInit}`.
   * App calls serialize through `appQueue`, same pattern as `tcQueue`.
   */
  private appKey: string | null = null;
  private appQueue: Promise<unknown> = Promise.resolve();

  private async agentBash(): Promise<Bash> {
    if (!this.bash) {
      const typecheck = (files: FileMap) => this.typecheckCapsule(files);
      this.bash = await createAgentBash(await this.getFiles(), {
        sandbox: this.sandbox,
        typecheck,
      });
    }
    return this.bash;
  }

  async getFiles(): Promise<FileMap> {
    const stored = await this.ctx.storage.get<FileMap>(FILES_KEY);
    return stored ?? { ...DEFAULT_FILES };
  }

  async setFiles(files: FileMap): Promise<void> {
    await this.ctx.storage.put(FILES_KEY, files);
    this.appKey = null;
  }

  async getMessages(): Promise<ChatMessage[]> {
    return (await this.ctx.storage.get<ChatMessage[]>(MESSAGES_KEY)) ?? [];
  }

  async setMessages(messages: ChatMessage[]): Promise<void> {
    await this.ctx.storage.put(MESSAGES_KEY, messages.slice(-60));
  }

  /** Build = validate + execute the server entry, smoke-run every query.
   *
   * The build also runs the real type check (ts-rust, serialized per session
   * — see `tcQueue`), but a type error never blocks it: diagnostics ride
   * along for the UI while the preview keeps working, because sucrase strips
   * types before QuickJS ever sees them. `lint`/`deploy` remain the blocking
   * gates. Without this, editing in the Code tab is the only loop that never
   * reports type errors at all.
   */
  async build(files?: FileMap): Promise<BuildResult> {
    const current = files ?? (await this.getFiles());
    // Sequential on purpose: one ts_rust.wasm instance peaks at ~69 MiB of
    // linear memory in a 128 MiB isolate, so the check never overlaps the
    // QuickJS run (see `tcQueue`).
    const checked = await this.typecheckCapsule(current);
    const result = await runCapsule(current, this.sandbox);
    return {
      ...result,
      files: current,
      diagnostics: checked.diagnostics,
      ...(checked.failure ? { typecheckFailure: checked.failure } : {}),
    };
  }

  /**
   * Real type check via ts-rust: assemble the capsule project (capsule files
   * plus pinned dependency declarations) and run `tsc --noEmit` semantics
   * over it. Serialized per session — see `tcQueue`.
   */
  async typecheckCapsule(files?: FileMap): Promise<TypecheckResult> {
    const current = files ?? (await this.getFiles());
    const task = async () => {
      const project = await buildCapsuleProject(current, (url, init) => fetch(url, init));
      return this.typechecker.typecheckFiles(project);
    };
    const run = this.tcQueue.then(task, task);
    this.tcQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** Run one bash command; syncs the bash FS back to stored files. */
  async exec(
    command: string,
    files?: FileMap,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; files: FileMap }> {
    const bash = await this.agentBash();
    const current = files ?? (await this.getFiles());
    const out = await execWithSync(bash, current, command);
    await this.setFiles(out.files);
    return out;
  }

  /** Adapter so Pi tools treat the DO as one session object. */
  private sessionApi(): SessionApi {
    return {
      getFiles: () => this.getFiles(),
      setFiles: (files) => this.setFiles(files),
      getMessages: () => this.getMessages(),
      setMessages: (messages) => this.setMessages(messages),
      build: (files) => this.build(files),
      exec: (command, files) => this.exec(command, files),
    };
  }

  /**
   * Pi boot probe (no key needed): opens the harness — running Pi's SQLite
   * migrations — and reports the session. A 500 here means Pi cannot boot
   * in this isolate; `busy` proves the scheduler is alive.
   */
  async piStatus(): Promise<{
    ok: boolean;
    busy: boolean;
    tools: string[];
    providers: string[];
    error?: string;
  }> {
    try {
      const busy = await this.pi.session().busy();
      return { ok: true, busy, tools: ["bash", "read_file", "write_file"], providers: ["opencode", "opencode-go"] };
    } catch (e) {
      return {
        ok: false,
        busy: false,
        tools: [],
        providers: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Requests forwarded from the front Worker (`stub.fetch`). Lifecycle owns
   * fetch dispatch and falls through here; only the Pi spike paths serve.
   */
  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/pi-status" && req.method === "GET") {
      return Response.json(await this.piStatus());
    }
    if (url.pathname === "/pi-harness" && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "expected a JSON body" }, { status: 400 });
      }
      if (!body || typeof body !== "object") {
        return Response.json({ error: "expected a JSON body" }, { status: 400 });
      }
      const { message, apiKey, gateway, model } = body as {
        message?: unknown;
        apiKey?: unknown;
        gateway?: unknown;
        model?: unknown;
      };
      if (typeof message !== "string" || !message.trim()) {
        return Response.json({ error: "empty message" }, { status: 400 });
      }
      if (typeof apiKey !== "string" || !apiKey.trim()) {
        return Response.json({ error: "no API key" }, { status: 401 });
      }
      return this.piChatResponse(message, apiKey, gateway, model);
    }
    return new Response("not found", { status: 404 });
  }

  private piChatResponse(message: string, apiKey: string, gateway: unknown, model: unknown): Response {
    const turns = this.piChatTurn(message, apiKey, gateway, model);
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const enc = new TextEncoder();
        const send = (event: AgentEvent) =>
          controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
        try {
          for await (const event of turns) send(event);
        } catch (e) {
          send({ type: "error", message: e instanceof Error ? e.message : String(e) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" },
    });
  }

  /**
   * One chat turn through the Pi-owned loop: per-request model, BYOK holder,
   * live event batches mapped to UI events, transcript synced back to
   * ChatMessage storage at the end (Pi keeps the durable copy; the UI keeps
   * rendering ChatMessages, so both engines stay interchangeable).
   */
  private async *piChatTurn(message: string, apiKey: string, gateway: unknown, model: unknown): Stream {
    this.byokHolder.current = { type: "api_key", key: apiKey };
    let files = await this.getFiles();
    const messages = await this.getMessages();
    messages.push({ role: "user", content: message });
    await this.setMessages(messages);

    const sess = this.pi.session();
    await sess.setModel(piDefaultsFor(gateway, model));
    this.piBuilds.length = 0;
    const stream = await sess.events();
    const pending: AgentEvent[] = [];
    stream.start(async (batches) => {
      for (const event of batches) pending.push(...mapPiEvents([event]));
      for (const build of this.piBuilds.splice(0)) {
        if (build.files) files = build.files;
        pending.push({ type: "build", result: build });
      }
    });

    const receipt = await sess.submit(message);
    const waiter = sess.wait(receipt.operationId);
    let result: { status: string; reason?: string } | undefined;
    waiter.then((r) => {
      result = r;
    });
    try {
      while (!result) {
        while (pending.length) yield pending.shift() as AgentEvent;
        await new Promise((r) => setTimeout(r, 80));
      }
      while (pending.length) yield pending.shift() as AgentEvent;
    } finally {
      await stream.stop();
    }
    for (const build of this.piBuilds.splice(0)) {
      if (build.files) files = build.files;
      yield { type: "build", result: build };
    }

    files = await this.getFiles();
    const transcript = piEntriesToChatMessages(await sess.messages());
    await this.setMessages(transcript);
    if (result.status === "done") {
      yield { type: "done", messages: transcript, files };
    } else {
      yield {
        type: "error",
        message: result.reason ? `pi run ended unanswered: ${result.reason}` : "pi run ended unanswered",
      };
    }
  }

  /**
   * Live app state for the app view: the persistent isolate runtime behind
   * `/api/app`, not the fresh-build snapshot. Initializes (fresh database)
   * when the files changed since the last init, and re-initializes once when
   * the runtime reports it was lost.
   */
  async appState(files?: FileMap): Promise<AppState> {
    const current = files ?? (await this.getFiles());
    const task = async (): Promise<AppState> => {
      const key = fileKey(current);
      if (this.appKey !== key) {
        const init = await initAppRuntime(current, this.sandbox);
        if (!init.ok) return init;
        this.appKey = key;
        return init;
      }
      const q = await queryAppRuntime(this.sandbox);
      if (!isNeedsInit(q)) return q;
      const init = await initAppRuntime(current, this.sandbox);
      if (!init.ok) return init;
      this.appKey = key;
      return init;
    };
    const run = this.appQueue.then(task, task);
    this.appQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** Run one app mutation (or action) and answer the refreshed query state. */
  async appMutate(kind: AppKind, name: string, args: unknown[], files?: FileMap): Promise<AppMutation> {
    const current = files ?? (await this.getFiles());
    const task = async (): Promise<AppMutation> => {
      const key = fileKey(current);
      if (this.appKey !== key) {
        const init = await initAppRuntime(current, this.sandbox);
        if (!init.ok) return init;
        this.appKey = key;
      }
      const m = await mutateAppRuntime(this.sandbox, kind, name, args);
      if (!isNeedsInit(m)) return m;
      const init = await initAppRuntime(current, this.sandbox);
      if (!init.ok) return init;
      this.appKey = key;
      const retry = await mutateAppRuntime(this.sandbox, kind, name, args);
      if (isNeedsInit(retry)) {
        return { ok: false, error: { name: "Runtime", message: "app runtime did not survive initialization" } };
      }
      return retry;
    };
    const run = this.appQueue.then(task, task);
    this.appQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async reset(): Promise<{ files: FileMap; messages: ChatMessage[] }> {
    const files: FileMap = { ...DEFAULT_FILES };
    await this.ctx.storage.put(FILES_KEY, files);
    await this.ctx.storage.put(MESSAGES_KEY, []);
    this.bash = null;
    this.appKey = null;
    return { files, messages: [] };
  }
}
