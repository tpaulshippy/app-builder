import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { boundChatTitle, capChatList, capMessages, checkChatDetailSize, checkSnapshotSize, shouldAutoSnapshot, snapshotMeta } from "./chats";
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
import { mapPiEvents, migrateLegacyTranscript, openPiHarness, piDefaultsFor, piEntriesToChatMessages } from "./pi-harness";
import { CAPSULE_TOOL_NAMES } from "./pi-tools";
import {
  cloneRepo,
  commitAndPush,
  gitExec,
  gitLog,
  gitStatus,
  identityFor,
  initAndPush,
  overlayLocalEdits,
  pruneSkipped,
  pullRepo,
  type GitMeta,
  type GitResult,
  type GitSnapshot,
} from "./gitops";
import type { GitHubUser } from "./github";
import {
  assertGitCapableToken,
  assertPushAccess,
  assertWorkflowScope,
  diagnosePushFailure,
  getTokenScopes,
  tokenKind,
} from "./github";

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
/** Monotonic counter bumped on every FileMap write (see setFiles). */
const FILES_VERSION_KEY = "files_version";
const MESSAGES_KEY = "messages";
/** Newest-first list of chat snapshot metadata (see ChatSnapshot). */
const CHATS_KEY = "chats";
/** Per-snapshot entry prefix: CHAT_<id> -> { meta, messages, files }. */
const CHAT_PREFIX = "chat:";
/** Cap on stored snapshots; oldest beyond this are dropped. */
export const MAX_CHATS = 100;
const GITHUB_TOKEN_KEY = "github_token";
const GITHUB_USER_KEY = "github_user";
/** OAuth scopes GitHub reported granting at login (see exchangeCode). */
const GITHUB_SCOPES_KEY = "github_scopes";
const GIT_META_KEY = "git_meta";
/**
 * Owner/repo open before the last logout. The logout itself drops the link
 * and history (so the next login cannot push to the previous user's repo),
 * but the files stay — and reopening the same repo must overlay them instead
 * of cloning over them. Consumed by the next successful clone.
 */
const GIT_PREV_REPO_KEY = "git_prev_repo";
/** Raw worktree paths the text-only FileMap cannot hold (see restoreSkipped). */
const GIT_SKIPPED_KEY = "git_skipped";
/** Chunk prefix for the sharded skipped-path list (see setSkippedPaths). */
const GIT_SKIPPED_CHUNK = "git_skipped_chunk:";
const GIT_SNAPSHOT_KEY = "git_snapshot";
/** Chunk prefix for the sharded `.git` snapshot (see putSnapshot). */
const GIT_SNAP_CHUNK = "git_snapshot_chunk:";
/** Value size kept far under the 2 MB single-key cap. */
const SNAP_CHUNK_CHARS = 200_000;

/**
 * Whole-turn ceiling for a PiHarness chat turn: attempts already time out
 * individually (MODEL_TIMEOUT_MS), but a run that never settles must not
 * hold the turn mutex forever. Expiry (or client disconnect) aborts the
 * wait and the run; the next turn continues from Pi's committed entries.
 */
export const PI_RUN_TIMEOUT_MS = 4 * 60_000;

export type ChatSnapshot = {
  id: string;
  title: string;
  createdAt: number;
  messageCount: number;
  preview: string;
  /** Full-transcript+files fingerprint; absent on entries written before it. */
  fingerprint?: string;
};

export type ChatDetail = ChatSnapshot & {
  messages: ChatMessage[];
  files: FileMap;
};

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
   * Serializes Pi turns per object: the holder and the session model are
   * isolate-wide, so a second turn must not set them while a first turn is
   * still submitting. All chat traffic now funnels through the Pi loop, so
   * one chain covers every route. Same promise-chain idiom as
   * `tcQueue`/`appQueue`; eviction clears it, which is the safe default.
   */
  private turnTail: Promise<void> = Promise.resolve();

  private acquireTurn(): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.turnTail;
    this.turnTail = previous.then(() => gate);
    return previous.then(() => release);
  }

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
    await this.ctx.storage.put(FILES_VERSION_KEY, ((await this.ctx.storage.get<number>(FILES_VERSION_KEY)) ?? 0) + 1);
    this.appKey = null;
  }

  async getMessages(): Promise<ChatMessage[]> {
    return (await this.ctx.storage.get<ChatMessage[]>(MESSAGES_KEY)) ?? [];
  }

  async setMessages(messages: ChatMessage[]): Promise<void> {
    await this.ctx.storage.put(MESSAGES_KEY, capMessages(messages));
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
      gitStatus: () => this.gitStatus(),
      gitLog: () => this.gitLog(),
      gitRun: (command) => this.gitRun(command),
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
      return { ok: true, busy, tools: [...CAPSULE_TOOL_NAMES], providers: ["opencode", "opencode-go"] };
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
    let ctrl: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        // The whole turn runs under the shared mutex: holder, session model,
        // and transcript are per-object, and streaming holds it until the
        // run settles.
        const release = await this.acquireTurn();
        // The run budget starts here, not at request time: queue-wait behind
        // an active turn must not eat into it.
        ctrl = new AbortController();
        timer = setTimeout(() => ctrl?.abort(), PI_RUN_TIMEOUT_MS);
        const turns = this.piChatTurn(message, apiKey, gateway, model, ctrl.signal);
        const enc = new TextEncoder();
        const send = (event: AgentEvent) =>
          controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
        // Mark the turn so bulk saves (Commit/Create) wait instead of
        // overwriting Pi edits that land after the browser's snapshot —
        // same invariant as /api/chat. In-memory: eviction clears it.
        this.setTurnActive(true);
        try {
          for await (const event of turns) send(event);
        } catch (e) {
          send({ type: "error", message: e instanceof Error ? e.message : String(e) });
        } finally {
          if (timer) clearTimeout(timer);
          try {
            this.setTurnActive(false);
          } catch {
            /* evicted mid-turn; flag is gone with the isolate */
          }
          release();
          controller.close();
        }
      },
      cancel: () => {
        ctrl?.abort();
        try {
          this.setTurnActive(false);
        } catch {
          /* evicted; nothing to clear */
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
   * rendering ChatMessages).
   *
   * The first turn for a session migrates any legacy ChatMessage transcript
   * into the Pi conversation, so history survives the cutover. `signal`
   * bounds the turn: timing out (or a client disconnect) aborts the wait
   * and the run. Never settle-or-hang: every path below either yields a
   * terminal event or returns after the signal.
   */
  private async *piChatTurn(
    message: string,
    apiKey: string,
    gateway: unknown,
    model: unknown,
    signal?: AbortSignal,
  ): Stream {
    if (signal?.aborted) {
      // Queued behind the mutex while the client went away (or the turn
      // already timed out): persist nothing, retain nothing, start nothing.
      yield {
        type: "error",
        message: "pi turn aborted before submitting — retry to run it",
      };
      return;
    }
    this.byokHolder.current = { type: "api_key", key: apiKey };
    let files = await this.getFiles();
    const legacy = await this.getMessages();

    const sess = this.pi.session();
    const defaults = piDefaultsFor(gateway, model);
    await sess.setModel(defaults);
    await migrateLegacyTranscript(
      await this.pi.pi(),
      legacy,
      defaults.provider,
      defaults.id,
      BACKGROUND_CONTEXT,
    );

    const messages = [...legacy, { role: "user" as const, content: message }];
    await this.setMessages(messages);
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

    // Submit inside the guarded region: the events subscription attached
    // above must stop on every path, including a rejected submit.
    try {
      if (signal?.aborted) {
        // Queued behind the mutex (or in setup) while the client went
        // away: never start the run, release the lock without side effects.
        await stream.stop();
        yield {
          type: "error",
          message: "pi turn aborted before submitting — retry to run it",
        };
        return;
      }
      let receipt: { operationId: string };
      try {
        receipt = await sess.submit(message);
      } catch (e) {
        // Nothing started: no run to recover, so drop the key now instead
        // of retaining it until eviction or the next turn.
        this.byokHolder.current = undefined;
        throw e;
      }
      const waiter = sess.wait(receipt.operationId, signal);
      let result: { status: string; reason?: string } | undefined;
      let stopped = false;
      waiter.then(
        (r) => {
          result = r;
        },
        () => {
          stopped = true;
        },
      );
      while (!result && !stopped && !signal?.aborted) {
        while (pending.length) yield pending.shift() as AgentEvent;
        await new Promise((r) => setTimeout(r, 80));
      }
      while (pending.length) yield pending.shift() as AgentEvent;
      if (!result) {
        // The wait was aborted (turn timeout or client disconnect): stop the
        // run too, instead of letting unattended tool edits land after the
        // turn-active flag clears. The run's committed entries stay in Pi's
        // transcript, so the next turn continues from them. Tools bound
        // themselves (TOOL_TIMEOUT_MS), so this abort cannot hang long.
        try {
          await sess.abort();
        } catch {
          /* evicted; nothing to abort */
        }
        this.byokHolder.current = undefined;
        yield {
          type: "error",
          message: "pi run aborted after the turn timeout — retry to continue",
        };
        return;
      }
      for (const build of this.piBuilds.splice(0)) {
        if (build.files) files = build.files;
        yield { type: "build", result: build };
      }

      files = await this.getFiles();
      const transcript = piEntriesToChatMessages(await sess.messages());
      await this.setMessages(transcript);
      // The turn settled: checkpoint it so every prompt/response pair is
      // kept without the user remembering to save. Best-effort (see
      // autoSnapshot) — a skipped checkpoint must not fail a good turn.
      await this.autoSnapshot();
      // Terminal now (done or unanswered): drop the key. The timeout path
      // above returns early with the run still going, so recovery attempts
      // keep working.
      this.byokHolder.current = undefined;
      if (result.status === "done") {
        yield { type: "done", messages: transcript, files };
      } else {
        yield {
          type: "error",
          message: result.reason ? `pi run ended unanswered: ${result.reason}` : "pi run ended unanswered",
        };
      }
      // The subscription stays live until stop() resolves below: drain
      // anything that arrived while yielding builds and syncing, so
      // trailing events cannot miss the SSE (the transcript sync is the
      // backstop either way).
      while (pending.length) yield pending.shift() as AgentEvent;
    } finally {
      await stream.stop();
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
    // Serialize with turns: a reset landing mid-run would otherwise be
    // undone by the turn's end-of-run transcript sync (and its Pi history
    // would survive while the visible one clears).
    const release = await this.acquireTurn();
    try {
      return await this.resetInner();
    } finally {
      release();
    }
  }

  /**
   * Clear agent context only (code kept): ChatMessages, the Pi transcript,
   * and the holder. Serialized with turns like reset(): clearing mid-run
   * would otherwise be undone by the turn's end-of-run sync. The transcript
   * is archived first (unless empty or unchanged), so New chat starts a
   * fresh session without losing the old one.
   */
  async clearChat(): Promise<void> {
    const release = await this.acquireTurn();
    try {
      await this.autoSnapshot();
      await this.setMessages([]);
      this.byokHolder.current = undefined;
      this.piBuilds.length = 0;
      try {
        await this.pi.session().reset(undefined);
      } catch (e) {
        console.warn("pi clear-chat failed (messages already cleared):", e instanceof Error ? e.message : String(e));
      }
    } finally {
      release();
    }
  }

  /**
   * Named checkpoints of the current chat + files. One snapshot per explicit
   * Save: messages and files are copied under CHAT_<id>, metadata stays in
   * the CHATS_KEY list (newest first, capped at MAX_CHATS).
   */
  async listChats(): Promise<ChatSnapshot[]> {
    return (await this.ctx.storage.get<ChatSnapshot[]>(CHATS_KEY)) ?? [];
  }

  async snapshotChat(title?: string, files?: FileMap): Promise<ChatSnapshot> {
    // Read before queueing: when the client sends its editor map during an
    // agent turn, the lock below would wait out the turn and then overwrite
    // the turn's files with the stale pre-turn map. Reject instead (409 at
    // the edge, like /api/files) so retrying after the turn captures both.
    const sawTurn = this.isTurnActive();
    // Serialized with turns like clearChat/resumeChat: two concurrent saves
    // must not read the same CHATS_KEY list and lose one entry, and a save
    // landing mid-run must not capture a half-synced transcript.
    const release = await this.acquireTurn();
    try {
      if (files && sawTurn) {
        throw new Error("an agent turn is in progress — wait for it to finish, then retry");
      }
      // The size check inside snapshotInner runs before any mutation: an
      // oversized map 413s without touching live files (a files-table
      // write would fail first with a 500).
      const meta = await this.snapshotInner(await this.getMessages(), files ?? (await this.getFiles()), title);
      // The Code tab keeps unsaved editor edits in browser memory: persist
      // the sent map only after the snapshot succeeds, so the checkpoint
      // captures what the user sees, not the last-saved server copy.
      if (files) await this.setFiles(files);
      return meta;
    } finally {
      release();
    }
  }

  /**
   * Lock-free checkpoint write: the caller must already hold the turn mutex
   * (snapshotChat acquires it; the turn-done and clearChat paths run inside
   * it), so concurrent saves cannot interleave.
   */
  private async snapshotInner(messages: ChatMessage[], files: FileMap, title?: string): Promise<ChatSnapshot> {
    // Same window the live session keeps (see setMessages): resuming a
    // wider snapshot would truncate it before resetting Pi and silently
    // lose the older restored context on the next turn.
    const capped = capMessages(messages);
    // Bound before measuring: over-long titles truncate instead of failing,
    // and the stored title is part of the measured value (see
    // checkSnapshotSize) so metadata alone cannot breach the value cap.
    const boundedTitle = boundChatTitle(title);
    checkSnapshotSize(capped, files, boundedTitle);
    const meta = snapshotMeta(crypto.randomUUID(), capped, files, boundedTitle);
    await this.ctx.storage.put<ChatDetail>(`${CHAT_PREFIX}${meta.id}`, { ...meta, messages, files });
    const prev = (await this.ctx.storage.get<ChatSnapshot[]>(CHATS_KEY)) ?? [];
    const { chats, evicted } = capChatList(prev, meta, MAX_CHATS);
    await this.ctx.storage.put(CHATS_KEY, chats);
    // Drop entries aged out of the capped list so storage does not grow.
    for (const id of evicted) await this.ctx.storage.delete(`${CHAT_PREFIX}${id}`);
    return meta;
  }

  /**
   * Best-effort checkpoint of the settled live state: skipped when empty or
   * already fingerprinted by the newest entry, and never allowed to fail the
   * turn (or the clear) it follows — the live state is already safe. Reads
   * inside the try so a storage failure cannot abort the caller either.
   */
  private async autoSnapshot(): Promise<void> {
    try {
      const messages = await this.getMessages();
      const files = await this.getFiles();
      const prev = (await this.ctx.storage.get<ChatSnapshot[]>(CHATS_KEY)) ?? [];
      if (!shouldAutoSnapshot(prev[0], messages, files)) return;
      await this.snapshotInner(messages, files);
    } catch (e) {
      console.warn("auto-snapshot skipped:", e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Rename a checkpoint's title. The transcript/files fingerprint is
   * untouched, so dedupe keeps working; serialized with turns like
   * snapshotChat because it reads-mutates-writes the same CHATS_KEY list.
   */
  async renameChat(id: string, title: string): Promise<ChatSnapshot> {
    const clean = boundChatTitle(title);
    if (!clean) throw new Error("snapshot title is required");
    const release = await this.acquireTurn();
    try {
      const key = `${CHAT_PREFIX}${id}`;
      const detail = await this.ctx.storage.get<ChatDetail>(key);
      if (!detail) throw new Error("chat snapshot not found");
      // The stored value is one key: a longer title can push a near-cap
      // snapshot over it, so measure the value actually written.
      checkChatDetailSize({ ...detail, title: clean });
      await this.ctx.storage.put<ChatDetail>(key, { ...detail, title: clean });
      const chats = (await this.ctx.storage.get<ChatSnapshot[]>(CHATS_KEY)) ?? [];
      await this.ctx.storage.put(
        CHATS_KEY,
        chats.map((c) => (c.id === id ? { ...c, title: clean } : c)),
      );
      const { messages: _m, files: _f, ...meta } = { ...detail, title: clean };
      return meta;
    } finally {
      release();
    }
  }

  /**
   * Restore a snapshot into the live session: messages + files replace the
   * current ones and the Pi transcript resets so the next turn continues
   * from the restored history (same posture as clearChat, serialized with
   * turns so a mid-run resume cannot be undone by the turn's sync).
   */
  async resumeChat(id: string): Promise<{ messages: ChatMessage[]; files: FileMap; built: BuildResult }> {
    const release = await this.acquireTurn();
    try {
      const detail = await this.ctx.storage.get<ChatDetail>(`${CHAT_PREFIX}${id}`);
      if (!detail) throw new Error("chat snapshot not found");
      await this.setMessages(detail.messages);
      await this.setFiles(detail.files);
      this.byokHolder.current = undefined;
      this.piBuilds.length = 0;
      try {
        await this.pi.session().reset(undefined);
      } catch (e) {
        // The messages/files above are already restored and retrying is
        // safe, so report the failure instead of success with a stale Pi
        // transcript: the next turn would otherwise continue from it.
        throw new Error(
          `chat restored but the agent transcript reset failed — retry resume: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      // Build under the same lock: a turn starting between restore and build
      // would change the session the response describes.
      const built = await this.build(detail.files);
      return { messages: detail.messages, files: detail.files, built };
    } finally {
      release();
    }
  }

  private async resetInner(): Promise<{ files: FileMap; messages: ChatMessage[] }> {
    const files: FileMap = { ...DEFAULT_FILES };
    await this.ctx.storage.put(FILES_KEY, files);
    // reset() clears the worktree outside setFiles, so bump the counter here:
    // otherwise a reset landing mid-git-op is invisible to gitRun's
    // version guard and the op's stale files overwrite the fresh defaults.
    await this.ctx.storage.put(FILES_VERSION_KEY, ((await this.ctx.storage.get<number>(FILES_VERSION_KEY)) ?? 0) + 1);
    await this.ctx.storage.put(MESSAGES_KEY, []);
    this.bash = null;
    this.appKey = null;
    // Pi owns a parallel transcript: without this the next Pi turn copies
    // the "cleared" history back into MESSAGES_KEY. Best-effort — reset
    // must succeed for files/messages even if Pi never booted.
    this.byokHolder.current = undefined;
    this.piBuilds.length = 0;
    try {
      await this.pi.session().reset(undefined);
    } catch (e) {
      console.warn("pi reset failed (files/messages already reset):", e instanceof Error ? e.message : String(e));
    }
    return { files, messages: [] };
  }

  // ---------- GitHub + git (just-git, server-side) ----------

  /**
   * Tail of the git queue. Git ops rehydrate a whole in-memory filesystem and
   * snapshot `.git` back to storage, so two overlapping ops would corrupt each
   * other's snapshot. Same promise-chain pattern as `tcQueue`.
   */
  private gitQueue: Promise<unknown> = Promise.resolve();

  /**
   * True while an agent turn streams for this session (set around the SSE
   * response in `/api/chat`). Bulk saves check it so a Commit/Create cannot
   * overwrite agent edits that landed after the browser's file snapshot.
   * In-memory on purpose: eviction clears it, which is the safe default.
   */
  private turnActive = false;

  setTurnActive(active: boolean): void {
    this.turnActive = active;
  }

  isTurnActive(): boolean {
    return this.turnActive;
  }

  private serializeGit<T>(task: () => Promise<T>): Promise<T> {
    const result = this.gitQueue.then(task, task);
    this.gitQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async getGitHubToken(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(GITHUB_TOKEN_KEY)) ?? null;
  }

  async setGitHubToken(token: string, user: GitHubUser, grantedScopes?: string[]): Promise<void> {
    await this.ctx.storage.put(GITHUB_TOKEN_KEY, token);
    await this.ctx.storage.put(GITHUB_USER_KEY, user);
    if (grantedScopes && grantedScopes.length) {
      await this.ctx.storage.put(GITHUB_SCOPES_KEY, grantedScopes);
    } else {
      await this.ctx.storage.delete(GITHUB_SCOPES_KEY);
    }
  }

  private async getSkippedPaths(): Promise<string[]> {
    // Chunked like the snapshot: thousands of skipped paths would exceed the
    // single-value cap as one array, and silently truncating them would leave
    // phantom deletions for the dropped paths.
    const count = await this.ctx.storage.get<number>(GIT_SKIPPED_KEY);
    if (!count) return [];
    let raw = "";
    for (let i = 0; i < count; i++) {
      raw += (await this.ctx.storage.get<string>(`${GIT_SKIPPED_CHUNK}${i}`)) ?? "";
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
    } catch {
      return [];
    }
  }

  private async setSkippedPaths(paths: string[]): Promise<void> {
    const uniq = [...new Set(paths)];
    if (!uniq.length) {
      await this.deleteSkippedPaths();
      return;
    }
    const raw = JSON.stringify(uniq);
    const chunks: string[] = [];
    for (let i = 0; i < raw.length; i += SNAP_CHUNK_CHARS) {
      chunks.push(raw.slice(i, i + SNAP_CHUNK_CHARS));
    }
    const oldCount = (await this.ctx.storage.get<number>(GIT_SKIPPED_KEY)) ?? 0;
    for (let i = 0; i < chunks.length; i++) {
      await this.ctx.storage.put<string>(`${GIT_SKIPPED_CHUNK}${i}`, chunks[i] as string);
    }
    await this.ctx.storage.put(GIT_SKIPPED_KEY, chunks.length);
    for (let i = chunks.length; i < oldCount; i++) {
      await this.ctx.storage.delete(`${GIT_SKIPPED_CHUNK}${i}`);
    }
  }

  private async deleteSkippedPaths(): Promise<void> {
    const count = (await this.ctx.storage.get<number>(GIT_SKIPPED_KEY)) ?? 0;
    for (let i = 0; i < count; i++) {
      await this.ctx.storage.delete(`${GIT_SKIPPED_CHUNK}${i}`);
    }
    await this.ctx.storage.delete(GIT_SKIPPED_KEY);
  }

  async clearGitHub(): Promise<void> {
    // Drop the repo link and history too: without this, the next account to
    // log into the same session would inherit the previous user's repo and
    // push to it with their own token. Routed through the git queue so an
    // in-flight op cannot put the snapshot/link back after the delete.
    // The owner/repo is remembered separately (no history, no token) so a
    // re-login + reopen of the same repo can keep local edits (see
    // cloneFromGitHub) instead of cloning over them.
    return this.serializeGit(async () => {
      const prevMeta = await this.ctx.storage.get<GitMeta>(GIT_META_KEY);
      await this.ctx.storage.delete(GITHUB_TOKEN_KEY);
      await this.ctx.storage.delete(GITHUB_USER_KEY);
      await this.ctx.storage.delete(GIT_META_KEY);
      await this.deleteSkippedPaths();
      await this.deleteSnapshot();
      if (prevMeta) {
        await this.ctx.storage.put(GIT_PREV_REPO_KEY, { owner: prevMeta.owner, repo: prevMeta.repo });
      }
      await this.ctx.storage.delete(GITHUB_SCOPES_KEY);
    });
  }

  async getGitHubStatus(): Promise<{
    connected: boolean;
    user: GitHubUser | null;
    linked: GitMeta | null;
    /** OAuth scopes on the stored token; [] when unknown (see getTokenScopes). */
    scopes: string[];
    /** Scopes GitHub reported granting at login; [] for older logins. */
    grantedScopes: string[];
    /** Token class without exposing the token (see tokenKind). */
    tokenKind: "oauth" | "github-app" | "other" | "missing";
  }> {
    const token = await this.getGitHubToken();
    const user = (await this.ctx.storage.get<GitHubUser>(GITHUB_USER_KEY)) ?? null;
    const linked = (await this.ctx.storage.get<GitMeta>(GIT_META_KEY)) ?? null;
    const scopes = token ? await getTokenScopes(token) : [];
    const grantedScopes = (await this.ctx.storage.get<string[]>(GITHUB_SCOPES_KEY)) ?? [];
    return { connected: Boolean(token), user, linked, scopes, grantedScopes, tokenKind: tokenKind(token) };
  }

  private async requireToken(): Promise<{ token: string; user: GitHubUser }> {
    const token = await this.getGitHubToken();
    if (!token) throw new Error("GitHub is not connected for this session");
    const user = (await this.ctx.storage.get<GitHubUser>(GITHUB_USER_KEY)) ?? null;
    if (!user) throw new Error("GitHub user is missing for this session");
    return { token, user };
  }

  private async getSnapshot(): Promise<GitSnapshot | null> {
    const count = await this.ctx.storage.get<number>(GIT_SNAPSHOT_KEY);
    if (!count) return null;
    let raw = "";
    for (let i = 0; i < count; i++) {
      raw += (await this.ctx.storage.get<string>(`${GIT_SNAP_CHUNK}${i}`)) ?? "";
    }
    try {
      return JSON.parse(raw) as GitSnapshot;
    } catch {
      return null;
    }
  }

  /**
   * The `.git` database is base64-encoded and would exceed the single-key
   * value cap (2 MB on SQLite-backed DOs) as one value, so it is sharded
   * across chunk keys. Old chunks are removed first so a smaller snapshot
   * never leaves stale chunks behind for the next read.
   */
  private async putSnapshot(snapshot: GitSnapshot): Promise<void> {
    const raw = JSON.stringify(snapshot);
    const chunks: string[] = [];
    for (let i = 0; i < raw.length; i += SNAP_CHUNK_CHARS) {
      chunks.push(raw.slice(i, i + SNAP_CHUNK_CHARS));
    }
    const oldCount = (await this.ctx.storage.get<number>(GIT_SNAPSHOT_KEY)) ?? 0;
    for (let i = 0; i < chunks.length; i++) {
      await this.ctx.storage.put<string>(`${GIT_SNAP_CHUNK}${i}`, chunks[i] as string);
    }
    await this.ctx.storage.put(GIT_SNAPSHOT_KEY, chunks.length);
    for (let i = chunks.length; i < oldCount; i++) {
      await this.ctx.storage.delete(`${GIT_SNAP_CHUNK}${i}`);
    }
  }

  private async deleteSnapshot(): Promise<void> {
    const count = (await this.ctx.storage.get<number>(GIT_SNAPSHOT_KEY)) ?? 0;
    for (let i = 0; i < count; i++) {
      await this.ctx.storage.delete(`${GIT_SNAP_CHUNK}${i}`);
    }
    await this.ctx.storage.delete(GIT_SNAPSHOT_KEY);
  }

  async cloneFromGitHub(opts: {
    owner: string;
    repo: string;
    branch?: string;
  }): Promise<{ files: FileMap; meta: GitMeta; skipped: string[]; output: string; kept: number }> {
    return this.serializeGit(async () => {
      const { token, user } = await this.requireToken();
      // Snapshot the pre-clone state first: reopening the same repo after a
      // logout/login must keep local edits as uncommitted changes, not wipe
      // them. A different repo (or a fresh session) still clones clean.
      const prevSnapshot = await this.getSnapshot();
      const prevMeta = await this.ctx.storage.get<GitMeta>(GIT_META_KEY);
      const prevRepo = await this.ctx.storage.get<{ owner: string; repo: string }>(GIT_PREV_REPO_KEY);
      const prevFiles = await this.getFiles();
      const r = await cloneRepo({
        token,
        owner: opts.owner,
        repo: opts.repo,
        branch: opts.branch,
        identity: identityFor(user.login),
      });
      let files = r.files;
      let kept = 0;
      const hadHistory = !!prevSnapshot && Object.keys(prevSnapshot).length > 0;
      // Same linked repo with history: plain reopen. Same logged-out repo:
      // logout drops the history by design, so the marker alone signals it.
      const sameLinkedRepo =
        !!prevMeta && prevMeta.owner === opts.owner && prevMeta.repo === opts.repo;
      const sameLoggedOutRepo =
        !prevMeta &&
        !!prevRepo &&
        prevRepo.owner === opts.owner &&
        prevRepo.repo === opts.repo;
      if ((sameLinkedRepo && hadHistory) || sameLoggedOutRepo) {
        const merged = overlayLocalEdits(r.files, prevFiles);
        files = merged.files;
        kept = merged.kept;
      }
      await this.putSnapshot(r.snapshot);
      await this.ctx.storage.put(GIT_META_KEY, r.meta);
      await this.setSkippedPaths(pruneSkipped(r.skippedPaths, files));
      await this.ctx.storage.put(FILES_KEY, files);
      await this.ctx.storage.delete(GIT_PREV_REPO_KEY);
      const keptNote =
        kept > 0
          ? `\nKept ${kept} local file(s) as uncommitted changes (same-repo reopen — check status/diff, then commit).`
          : "";
      return { files, meta: r.meta, skipped: r.skipped, output: r.output + keptNote, kept };
    });
  }

  async pushCurrentToRemote(opts: {
    remoteUrl: string;
    meta: GitMeta;
    message: string;
  }): Promise<{ output: string }> {
    return this.serializeGit(async () => {
      const { token, user } = await this.requireToken();
      // A GitHub-App credential can never push: fail before the API
      // pre-check and the git attempt, both of which mislead for it.
      assertGitCapableToken(token);
      // Fail fast with a why-and-how message: creating the repo proves API
      // access, but the git push can still 403 (no write access, stale token).
      await assertPushAccess(token, opts.meta.owner, opts.meta.repo, user.login).catch((e) => {
        if (e instanceof Error && /401|404|403|no write access|write access/i.test(e.message)) throw e;
        // Metadata lookup hiccup — let the git attempt report the real error.
      });
      const files = await this.getFiles();
      let r: { snapshot: GitSnapshot; output: string };
      try {
        // Known-missing `workflow` scope + workflow files in the push is a
        // certain 403 (verified live): fail here with the re-login fix
        // instead of attempting the push.
        assertWorkflowScope(await getTokenScopes(token), Object.keys(files));
        r = await initAndPush({
          token,
          files,
          remoteUrl: opts.remoteUrl,
          branch: opts.meta.branch,
          message: opts.message,
          identity: identityFor(user.login),
        });
      } catch (e) {
        // The pre-check passed but git refused: attach the precise diagnosis
        // (token scopes, workflow files, endpoint probe) instead of guessing.
        const msg = e instanceof Error ? e.message : String(e);
        const diag = await diagnosePushFailure(token, {
          login: user.login,
          owner: opts.meta.owner,
          repo: opts.meta.repo,
          fileKeys: Object.keys(files),
        });
        throw new Error(`${msg}\n${diag}`);
      }
      await this.putSnapshot(r.snapshot);
      await this.ctx.storage.put(GIT_META_KEY, opts.meta);
      return { output: r.output };
    });
  }

  async commitPush(message: string): Promise<{ output: string }> {
    // Every read happens inside the queue: a clone queued ahead of this commit
    // must not have its files pushed to the previously linked repo.
    return this.serializeGit(async () => {
      const { token, user } = await this.requireToken();
      const meta = await this.ctx.storage.get<GitMeta>(GIT_META_KEY);
      if (!meta) throw new Error("no linked repo: open or create one first");
      // A GitHub-App credential can never push: fail before the local commit.
      assertGitCapableToken(token);
      // Fail fast before committing locally: a public repo clones fine with
      // read-only access, then the push 403s and strands the commit.
      await assertPushAccess(token, meta.owner, meta.repo, user.login).catch((e) => {
        if (e instanceof Error && /401|404|403|no write access|write access/i.test(e.message)) throw e;
        // Metadata lookup hiccup — let the git attempt report the real error.
      });
      const snapshot = await this.getSnapshot();
      if (!snapshot) throw new Error("no git history stored for this session");
      const files = await this.getFiles();
      let r: { snapshot: GitSnapshot; output: string };
      try {
        // Same certain-403 guard as the create path, placed before the local
        // commit so a scope-refused push does not strand a local-only commit.
        assertWorkflowScope(await getTokenScopes(token), Object.keys(files));
        r = await commitAndPush({
          token,
          files,
          snapshot,
          skippedPaths: await this.getSkippedPaths(),
          meta,
          message,
          identity: identityFor(user.login),
        });
      } catch (e) {
        // The pre-check passed but git refused (e.g. owner pushing workflow
        // files with a pre-`workflow`-scope token): attach the precise
        // diagnosis instead of the generic access hint.
        const msg = e instanceof Error ? e.message : String(e);
        const diag = await diagnosePushFailure(token, {
          login: user.login,
          owner: meta.owner,
          repo: meta.repo,
          fileKeys: Object.keys(files),
        });
        throw new Error(`${msg}\n${diag}`);
      }
      await this.putSnapshot(r.snapshot);
      // A path back in the FileMap is owned by it again: prune so a later
      // removal reads as a real deletion instead of being resurrected.
      await this.setSkippedPaths(pruneSkipped(await this.getSkippedPaths(), files));
      return { output: r.output };
    });
  }

  async pullFromRemote(): Promise<{
    files: FileMap;
    skipped: string[];
    output: string;
    conflict: boolean;
  }> {
    return this.serializeGit(async () => {
      const { token, user } = await this.requireToken();
      const meta = await this.ctx.storage.get<GitMeta>(GIT_META_KEY);
      if (!meta) throw new Error("no linked repo: open or create one first");
      const snapshot = await this.getSnapshot();
      if (!snapshot) throw new Error("no git history stored for this session");
      const files = await this.getFiles();
      const skippedPaths = await this.getSkippedPaths();
      const r = await pullRepo({ token, files, snapshot, skippedPaths, meta, identity: identityFor(user.login) });
      await this.ctx.storage.put(FILES_KEY, r.files);
      await this.putSnapshot(r.snapshot);
      await this.setSkippedPaths(pruneSkipped(r.skippedPaths, r.files));
      return { files: r.files, skipped: r.skipped, output: r.output, conflict: !r.ok };
    });
  }

  async gitStatus(): Promise<string> {
    // Routed through the git queue: setSkippedPaths writes chunks + count as
    // separate storage ops, and an unserialized status could read a torn mix
    // mid-write, silently degrade to an empty restore list, and report the
    // phantom deletions this feature exists to fix.
    return this.serializeGit(async () => {
      const files = await this.getFiles();
      const snapshot = await this.getSnapshot();
      return gitStatus({ files, snapshot, skippedPaths: await this.getSkippedPaths() });
    });
  }

  async gitLog(max = 20): Promise<string> {
    // Same torn-read hazard as gitStatus (see above): a snapshot read
    // overlapping a putSnapshot can fail to parse and misreport "no
    // commits yet".
    return this.serializeGit(async () => {
      return gitLog({ snapshot: await this.getSnapshot(), max });
    });
  }

  async gitRun(command: string): Promise<GitResult & { files: FileMap }> {
    return this.serializeGit(async () => {
      const stash = await this.getGitHubStatus().catch(() => ({
        connected: false as const,
        user: null,
        linked: null,
        scopes: [] as string[],
        grantedScopes: [] as string[],
        tokenKind: "missing" as const,
      }));
      const token = (await this.getGitHubToken()) ?? "";
      const user = stash.user ?? { login: "app-builder", id: 0 };
      const meta = stash.linked;
      const snapshot = await this.getSnapshot();
      const files = await this.getFiles();
      const versionBefore = (await this.ctx.storage.get<number>(FILES_VERSION_KEY)) ?? 0;
      const r = await gitExec({
        token,
        files,
        snapshot,
        skippedPaths: await this.getSkippedPaths(),
        meta,
        identity: identityFor(user.login),
        command,
      });
      // A failed network command (push/pull/fetch) gets the same precise
      // diagnosis as Commit+push — but only for auth-shaped failures, never
      // for merge conflicts or local errors.
      const sub = command.trim().replace(/^git\s+/, "").split(/\s+/)[0] ?? "";
      if (
        !r.result.ok &&
        meta &&
        token &&
        ["push", "pull", "fetch"].includes(sub) &&
        /401|403|workflow|forbidden|permission|not accessible/i.test(
          `${r.result.stdout}\n${r.result.stderr}`,
        )
      ) {
        const diag = await diagnosePushFailure(token, {
          login: user.login,
          owner: meta.owner,
          repo: meta.repo,
          fileKeys: Object.keys(files),
        });
        r.result.stderr = `${r.result.stderr}\n${diag}`;
      }
      // A timed-out call keeps running server-side: withToolTimeout only wins
      // the race client-side. If the FileMap moved on while the op ran (agent
      // or user edits after the timeout), overwriting it would discard newer
      // work — persist the fresh `.git` state but leave the newer files alone.
      const versionAfter = (await this.ctx.storage.get<number>(FILES_VERSION_KEY)) ?? 0;
      if (versionAfter !== versionBefore) {
        if (r.snapshot) await this.putSnapshot(r.snapshot);
        await this.setSkippedPaths(pruneSkipped(r.skippedPaths, await this.getFiles()));
        const current = await this.getFiles();
        if (meta && r.branch && r.branch !== meta.branch) {
          await this.ctx.storage.put(GIT_META_KEY, { ...meta, branch: r.branch });
        }
        return { ...r.result, files: current };
      }
      // Persist whatever the command changed.
      await this.ctx.storage.put(FILES_KEY, r.files);
      if (r.snapshot) await this.putSnapshot(r.snapshot);
      await this.setSkippedPaths(pruneSkipped(r.skippedPaths, r.files));
      // A branch switch persists in `.git` but not in the link metadata, so a
      // later commitPush would push the old branch. Refresh the link.
      if (meta && r.branch && r.branch !== meta.branch) {
        await this.ctx.storage.put(GIT_META_KEY, { ...meta, branch: r.branch });
      }
      return { ...r.result, files: r.files };
    });
  }
}
