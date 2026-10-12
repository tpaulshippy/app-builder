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
    default:
      return name.replace(/_/g, " ");
  }
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
      const isDevCycle = /\b(build|tests|lint|deploy)\b/.test(command);
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
      const path = typeof args["path"] === "string" ? (args["path"] as string) : "";
      // Own-property check: `in` also matches inherited keys like
      // `constructor`, whose value is a function that would throw below.
      const contents = Object.hasOwn(files, path) ? files[path] : undefined;
      if (contents === undefined) {
        return { files, output: `no such file: ${path}. Known: ${Object.keys(files).join(", ")}`, ok: false };
      }
      return { files, output: contents, ok: true };
    }
    case "write_file": {
      const path = typeof args["path"] === "string" ? (args["path"] as string).trim() : "";
      if (!path || !isSafePath(path)) {
        return { files, output: `refusing unsafe path: ${path || "(empty)"}`, ok: false };
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
    default:
      return { files, output: `unknown tool: ${name}`, ok: false };
  }
}
