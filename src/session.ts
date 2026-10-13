import { DurableObject } from "cloudflare:workers";
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
import {
  cloneRepo,
  commitAndPush,
  gitExec,
  gitLog,
  gitStatus,
  identityFor,
  initAndPush,
  pullRepo,
  type GitMeta,
  type GitResult,
  type GitSnapshot,
} from "./gitops";
import type { GitHubUser } from "./github";

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
};

const FILES_KEY = "files";
/** Monotonic counter bumped on every FileMap write (see setFiles). */
const FILES_VERSION_KEY = "files_version";
const MESSAGES_KEY = "messages";
const GITHUB_TOKEN_KEY = "github_token";
const GITHUB_USER_KEY = "github_user";
const GIT_META_KEY = "git_meta";
/** Raw worktree paths the text-only FileMap cannot hold (see restoreSkipped). */
const GIT_SKIPPED_KEY = "git_skipped";
const GIT_SNAPSHOT_KEY = "git_snapshot";
/** Chunk prefix for the sharded `.git` snapshot (see putSnapshot). */
const GIT_SNAP_CHUNK = "git_snapshot_chunk:";
/** Value size kept far under the 2 MB single-key cap. */
const SNAP_CHUNK_CHARS = 200_000;

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
    // reset() clears the worktree outside setFiles, so bump the counter here:
    // otherwise a reset landing mid-git-op is invisible to gitRun's
    // version guard and the op's stale files overwrite the fresh defaults.
    await this.ctx.storage.put(FILES_VERSION_KEY, ((await this.ctx.storage.get<number>(FILES_VERSION_KEY)) ?? 0) + 1);
    await this.ctx.storage.put(MESSAGES_KEY, []);
    this.bash = null;
    this.appKey = null;
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

  async setGitHubToken(token: string, user: GitHubUser): Promise<void> {
    await this.ctx.storage.put(GITHUB_TOKEN_KEY, token);
    await this.ctx.storage.put(GITHUB_USER_KEY, user);
  }

  private async getSkippedPaths(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(GIT_SKIPPED_KEY)) ?? [];
  }

  private async setSkippedPaths(paths: string[]): Promise<void> {
    await this.ctx.storage.put(GIT_SKIPPED_KEY, [...new Set(paths)].slice(0, 2000));
  }

  async clearGitHub(): Promise<void> {
    // Drop the repo link and history too: without this, the next account to
    // log into the same session would inherit the previous user's repo and
    // push to it with their own token. Routed through the git queue so an
    // in-flight op cannot put the snapshot/link back after the delete.
    return this.serializeGit(async () => {
      await this.ctx.storage.delete(GITHUB_TOKEN_KEY);
      await this.ctx.storage.delete(GITHUB_USER_KEY);
      await this.ctx.storage.delete(GIT_META_KEY);
      await this.ctx.storage.delete(GIT_SKIPPED_KEY);
      await this.deleteSnapshot();
    });
  }

  async getGitHubStatus(): Promise<{
    connected: boolean;
    user: GitHubUser | null;
    linked: GitMeta | null;
  }> {
    const token = await this.getGitHubToken();
    const user = (await this.ctx.storage.get<GitHubUser>(GITHUB_USER_KEY)) ?? null;
    const linked = (await this.ctx.storage.get<GitMeta>(GIT_META_KEY)) ?? null;
    return { connected: Boolean(token), user, linked };
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
  }): Promise<{ files: FileMap; meta: GitMeta; skipped: string[]; output: string }> {
    return this.serializeGit(async () => {
      const { token, user } = await this.requireToken();
      const r = await cloneRepo({
        token,
        owner: opts.owner,
        repo: opts.repo,
        branch: opts.branch,
        identity: identityFor(user.login),
      });
      await this.putSnapshot(r.snapshot);
      await this.ctx.storage.put(GIT_META_KEY, r.meta);
      await this.setSkippedPaths(r.skippedPaths);
      await this.ctx.storage.put(FILES_KEY, r.files);
      return { files: r.files, meta: r.meta, skipped: r.skipped, output: r.output };
    });
  }

  async pushCurrentToRemote(opts: {
    remoteUrl: string;
    meta: GitMeta;
    message: string;
  }): Promise<{ output: string }> {
    return this.serializeGit(async () => {
      const { token, user } = await this.requireToken();
      const files = await this.getFiles();
      const r = await initAndPush({
        token,
        files,
        remoteUrl: opts.remoteUrl,
        branch: opts.meta.branch,
        message: opts.message,
        identity: identityFor(user.login),
      });
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
      const snapshot = await this.getSnapshot();
      if (!snapshot) throw new Error("no git history stored for this session");
      const files = await this.getFiles();
      const r = await commitAndPush({
        token,
        files,
        snapshot,
        skippedPaths: await this.getSkippedPaths(),
        meta,
        message,
        identity: identityFor(user.login),
      });
      await this.putSnapshot(r.snapshot);
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
      await this.setSkippedPaths(r.skippedPaths);
      return { files: r.files, skipped: r.skipped, output: r.output, conflict: !r.ok };
    });
  }

  async gitStatus(): Promise<string> {
    const files = await this.getFiles();
    const snapshot = await this.getSnapshot();
    return gitStatus({ files, snapshot, skippedPaths: await this.getSkippedPaths() });
  }

  async gitLog(max = 20): Promise<string> {
    return gitLog({ snapshot: await this.getSnapshot(), max });
  }

  async gitRun(command: string): Promise<GitResult & { files: FileMap }> {
    return this.serializeGit(async () => {
      const stash = await this.getGitHubStatus().catch(() => ({
        connected: false as const,
        user: null,
        linked: null,
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
      // A timed-out call keeps running server-side: withToolTimeout only wins
      // the race client-side. If the FileMap moved on while the op ran (agent
      // or user edits after the timeout), overwriting it would discard newer
      // work — persist the fresh `.git` state but leave the newer files alone.
      const versionAfter = (await this.ctx.storage.get<number>(FILES_VERSION_KEY)) ?? 0;
      if (versionAfter !== versionBefore) {
        if (r.snapshot) await this.putSnapshot(r.snapshot);
        const current = await this.getFiles();
        if (meta && r.branch && r.branch !== meta.branch) {
          await this.ctx.storage.put(GIT_META_KEY, { ...meta, branch: r.branch });
        }
        return { ...r.result, files: current };
      }
      // Persist whatever the command changed.
      await this.ctx.storage.put(FILES_KEY, r.files);
      if (r.snapshot) await this.putSnapshot(r.snapshot);
      // A branch switch persists in `.git` but not in the link metadata, so a
      // later commitPush would push the old branch. Refresh the link.
      if (meta && r.branch && r.branch !== meta.branch) {
        await this.ctx.storage.put(GIT_META_KEY, { ...meta, branch: r.branch });
      }
      return { ...r.result, files: r.files };
    });
  }
}
