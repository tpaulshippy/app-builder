/**
 * Shared capsule tool execution for the Pi paths.
 *
 * Extracted from `piAgentTurn` when the Pi extension needed the same
 * semantics a second time: `bash` (just-bash shell incl. the
 * build/tests/lint/deploy dev cycle), `read_file`, and `write_file`, each
 * followed by the capsule build feedback the model acts on. The executor
 * returns data only — no events, no transcript writes — so both the manual
 * turn loop (`pi-agent.ts`) and Pi `ToolRegistration`s (`pi-tools.ts`)
 * share it.
 */

import {
  buildFeedback,
  TOOL_TIMEOUT_MS,
  withToolTimeout,
  type SessionApi,
} from "./agent";
import { isSafePath } from "./paths";
import { isWorktreeKey } from "./gitops";
import type { BuildResult, FileMap } from "./session";

export type CapsuleToolOutcome = {
  /** Files after the call (callers persist and re-render from these). */
  files: FileMap;
  /** Full report text: command output plus build feedback. */
  output: string;
  /** False when the command, write, or follow-up build failed. */
  ok: boolean;
  /** Present when the call ran the capsule build (write, dev cycle, or shell file change). */
  build?: BuildResult;
};

/** Human-readable one-liner for a tool call, for transcripts and the UI. */
export function describeCapsuleTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "bash":
      return typeof args["command"] === "string" && args["command"] ? `$ ${String(args["command"]).slice(0, 80)}` : "shell";
    case "write_file":
      return typeof args["path"] === "string" && args["path"] ? `write ${args["path"]}` : "write";
    case "read_file":
      return typeof args["path"] === "string" && args["path"] ? `read ${args["path"]}` : "read";
    case "git_status":
      return "git status";
    case "git_log":
      return "git log";
    case "git":
      return typeof args["command"] === "string" && args["command"]
        ? `git ${String(args["command"]).slice(0, 80)}`
        : "git";
    default:
      return name.replace(/_/g, " ");
  }
}

const DEV_CYCLE_COMMANDS = new Set(["build", "tests", "lint", "deploy"]);
/**
 * True when the shell command invokes the capsule dev cycle: any
 * `&&`/`||`/`;`/`|`-separated segment whose first word is a dev command.
 * A bare substring test overmatches (`ls | grep build` triggers a full
 * QuickJS run plus serialized ts-rust typecheck for a read-only command).
 * Exotic prefixes (`! build`, `(build)`, `FOO=1 build`) intentionally miss
 * and fall through to the file-change check below.
 */
export function isDevCycleCommand(command: string): boolean {
  return command
    .split(/&&|\|\||[;|]/)
    .map((segment) => segment.trim().split(/\s+/, 1)[0] ?? "")
    .some((word) => DEV_CYCLE_COMMANDS.has(word));
}

/**
 * Collapse `.` segments (`./server/index.ts` -> `server/index.ts`) so the
 * model cannot create a shadow key the capsule loader never reads.
 * `..` segments are left for isSafePath to reject.
 */
export function normalizeCapsulePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment !== ".")
    .join("/");
}

/** True when two file maps hold the same paths with the same contents. */
export function sameFiles(a: FileMap, b: FileMap): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (a[ka[i] as string] !== b[kb[i] as string]) return false;
  }
  return true;
}

/**
 * Run one capsule tool call. `files` is the caller's current snapshot;
 * shell mutations come back in `outcome.files`.
 */
export async function execCapsuleTool(
  session: SessionApi,
  files: FileMap,
  name: string,
  args: Record<string, unknown>,
  toolTimeoutMs: number = TOOL_TIMEOUT_MS,
): Promise<CapsuleToolOutcome> {
  switch (name) {
    case "bash": {
      const command = typeof args["command"] === "string" ? (args["command"] as string) : "";
      const before = files;
      let r: { stdout: string; stderr: string; exitCode: number; files: FileMap };
      try {
        r = await withToolTimeout(session.exec(command, files), toolTimeoutMs, "shell command");
      } catch (e) {
        // The shell may still complete later and persist via exec(): return
        // a fresh read — not the pre-command snapshot — so callers don't
        // clobber its eventual edits with stale state. A completion landing
        // after this read can still race; exec has no abort.
        return {
          files: await session.getFiles(),
          output: `$ ${command}\nbuild check failed: ${e instanceof Error ? e.message : String(e)}`,
          ok: false,
        };
      }
      files = r.files;
      const head = `$ ${command}\n`;
      let out = head + (r.stdout || "") + (r.stderr ? `\nstderr:\n${r.stderr}` : "") + `\n(exit ${r.exitCode})`;
      let ok = r.exitCode === 0;
      // Keep the preview live when the agent ran the dev cycle, and make
      // sure TypeScript errors reach the model: session.build() carries
      // the ts-rust verdict, while the shell's own `build` output does
      // not. The same applies when the shell itself changed files.
      const isDevCycle = isDevCycleCommand(command);
      if (isDevCycle || !sameFiles(before, files)) {
        try {
          const built = await withToolTimeout(session.build(files), toolTimeoutMs, "build");
          if (built.files) files = built.files;
          out = `${out.slice(0, 6000)}\n${buildFeedback(built)}`;
          ok = ok && built.ok;
          return { files, output: out, ok, build: built };
        } catch (e) {
          out += `\nbuild check failed: ${e instanceof Error ? e.message : String(e)}`;
          return { files, output: out, ok: false };
        }
      }
      return { files, output: out, ok };
    }
    case "read_file": {
      files = await session.getFiles();
      const raw = typeof args["path"] === "string" ? (args["path"] as string) : "";
      const path = normalizeCapsulePath(raw);
      // Own-property check: `in` also matches inherited keys like
      // `constructor`, whose value is a function that would throw below.
      const contents = Object.hasOwn(files, path) ? files[path] : undefined;
      if (contents === undefined) {
        return { files, output: `no such file: ${path}. Known: ${Object.keys(files).join(", ")}`, ok: false };
      }
      return { files, output: contents, ok: true };
    }
    case "write_file": {
      const raw = typeof args["path"] === "string" ? (args["path"] as string).trim() : "";
      const path = normalizeCapsulePath(raw);
      if (!path || !isSafePath(path)) {
        return { files, output: `refusing unsafe path: ${path || "(empty)"}`, ok: false };
      }
      // Same restriction as the editor APIs: `.git/...` keys would leave
      // FileMap entries that git deliberately ignores.
      if (!isWorktreeKey(path)) {
        return { files, output: `refusing git-internal path: ${path}`, ok: false };
      }
      const content = typeof args["content"] === "string" ? (args["content"] as string) : "";
      files = { ...(await session.getFiles()), [path]: content };
      await session.setFiles(files);
      // Report the build (including the ts-rust type verdict) back to
      // the model: sucrase strips types without checking them, so
      // without this a type error is invisible until lint/deploy.
      try {
        const built = await withToolTimeout(session.build(files), toolTimeoutMs, "build");
        if (built.files) files = built.files;
        return { files, output: `wrote ${path} (${content.length} chars)\n${buildFeedback(built)}`, ok: built.ok, build: built };
      } catch (e) {
        return {
          files,
          output: `wrote ${path} (${content.length} chars)\nbuild check failed: ${e instanceof Error ? e.message : String(e)}`,
          ok: false,
        };
      }
    }
    case "git_status": {
      try {
        // Behind serializeGit server-side: bound like every other queued
        // call so a stalled queue fails visibly instead of wedging the turn
        // until the run abort.
        const out = session.gitStatus
          ? await withToolTimeout(session.gitStatus(), toolTimeoutMs, "git status")
          : "git is not wired for this session";
        return { files, output: out, ok: true };
      } catch (e) {
        return { files, output: `git status failed: ${e instanceof Error ? e.message : String(e)}`, ok: false };
      }
    }
    case "git_log": {
      try {
        const out = session.gitLog
          ? await withToolTimeout(session.gitLog(), toolTimeoutMs, "git log")
          : "git is not wired for this session";
        return { files, output: out, ok: true };
      } catch (e) {
        return { files, output: `git log failed: ${e instanceof Error ? e.message : String(e)}`, ok: false };
      }
    }
    case "git": {
      const command = typeof args["command"] === "string" ? (args["command"] as string).trim() : "";
      if (!command) {
        return { files, output: "expected { command: string }, e.g. { command: `diff --stat` }", ok: false };
      }
      if (!session.gitRun) {
        return { files, output: "git is not wired for this session", ok: false };
      }
      // Network I/O behind a serialized queue: bound it like the shell,
      // so a stalled push fails visibly instead of wedging the turn.
      try {
        const r = await withToolTimeout(session.gitRun(command), toolTimeoutMs, "git command");
        // gitRun persists internally and returns the authoritative map —
        // take it as-is (see the no-writeback rule in pi-tools.ts).
        return {
          files: r.files,
          output: [r.stdout, r.stderr].filter(Boolean).join("\n") || "(no output)",
          ok: r.ok,
        };
      } catch (e) {
        return { files, output: `git ${command} failed: ${e instanceof Error ? e.message : String(e)}`, ok: false };
      }
    }
    default:
      return { files, output: `unknown tool: ${name}`, ok: false };
  }
}
