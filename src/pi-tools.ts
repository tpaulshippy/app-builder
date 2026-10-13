/**
 * The capsule workspace as Pi tools.
 *
 * `bash` (just-bash shell with the build/tests/lint/deploy dev cycle),
 * `read_file`, `write_file` as Pi `ToolRegistration`s closing over the
 * session, plus the capsule instructions as the `preamble` prompt section.
 * Execution semantics (report text, ok flags, follow-up builds) come from
 * the shared `execCapsuleTool`.
 *
 * Replay policy: `read_file` is safe to rerun after a crash; `bash` runs
 * arbitrary code with side effects and must never rerun (the model gets an
 * interrupted result instead); `write_file` is unsafe because a crash
 * between persisting and recovery could replay a stale whole-file
 * replacement over a newer editor save. `bash` and `write_file` are also
 * sequential: they share the shell FS / file map, so one round's calls run
 * in order (one sequential call makes its whole round sequential).
 *
 * Open item: no approval gate. `deploy` runs inside `bash` like any other
 * command; a `beforeTool` approval hook needs a UI round-trip that does not
 * exist yet (see PR notes).
 */

import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type Extension,
} from "@earendil-works/pi-durable";
import { SYSTEM, type SessionApi } from "./agent";
import { execCapsuleTool } from "./capsule-tool-exec";
import type { BuildResult } from "./session";

/** Mirror the manual loop's transcript cap: one verbose call must not
 * inflate the durable transcript and provider context. The marker matters:
 * without it the model treats the prefix as the whole file and can
 * overwrite while dropping the unseen suffix. */
function boundedToolText(text: string): string {
  return text.length > 8000 ? `${text.slice(0, 8000)}\n…(truncated, full output ${text.length} chars)` : text;
}

/** Pi extension for one capsule session. Install on the Harness registry. */
export function createCapsuleExtension(
  session: SessionApi,
  hooks?: { onBuild?: (build: BuildResult) => void },
): Extension {
  const report = (outcome: { build?: BuildResult }) => {
    if (outcome.build) hooks?.onBuild?.(outcome.build);
  };
  const bash = defineTool({
    name: "bash",
    description:
      "Run a bash command in the capsule workspace (/app). Use ls/cat/grep/sed/jq to inspect, and the custom commands build, tests, lint, deploy to check and publish your work. Always run build after editing, and tests + lint before deploy.",
    parameters: Type.Object({
      command: Type.String({ description: "The bash command, e.g. ls server && build" }),
    }),
    replay: "unsafe",
    executionMode: "sequential",
    execute: async (args) => {
      // No writeback here: exec() already persists shell mutations and the
      // write path persists itself. A whole-map write from the (possibly
      // stale) input snapshot would clobber newer editor saves.
      const outcome = await execCapsuleTool(
        session,
        await session.getFiles(),
        "bash",
        args as unknown as Record<string, unknown>,
      );
      report(outcome);
      return { content: [{ type: "text", text: boundedToolText(outcome.output) }], isError: !outcome.ok };
    },
  });

  const readFile = defineTool({
    name: "read_file",
    description: "Read a file's current contents without shell quoting.",
    parameters: Type.Object({
      path: Type.String({ description: "File path, e.g. server/index.ts" }),
    }),
    replay: "safe",
    execute: async (args) => {
      const outcome = await execCapsuleTool(
        session,
        await session.getFiles(),
        "read_file",
        args as unknown as Record<string, unknown>,
      );
      return { content: [{ type: "text", text: boundedToolText(outcome.output) }], isError: !outcome.ok };
    },
  });

  const writeFile = defineTool({
    name: "write_file",
    description:
      "Create or overwrite a file. This is the usual way to change the app. Write complete file contents, not a diff.",
    parameters: Type.Object({
      path: Type.String({ description: "File path, e.g. server/index.ts" }),
      content: Type.String({ description: "The full new contents of the file" }),
    }),
    // Unsafe: a crash after persisting, followed by an editor save and then
    // recovery, would replay this stale whole-file replacement over the
    // newer save. The model re-issues the write from a fresh read instead.
    replay: "unsafe",
    // Read-modify-write on the shared file map: parallel writes would each
    // read the same snapshot and the later setFiles would drop the earlier
    // edit. Sequential, like bash.
    executionMode: "sequential",
    execute: async (args) => {
      // No writeback: the write path persists itself (see execCapsuleTool).
      // Writing back the input snapshot would clobber newer editor saves
      // that landed during the build.
      const outcome = await execCapsuleTool(
        session,
        await session.getFiles(),
        "write_file",
        args as unknown as Record<string, unknown>,
      );
      report(outcome);
      return { content: [{ type: "text", text: boundedToolText(outcome.output) }], isError: !outcome.ok };
    },
  });

  return defineExtension({
    name: "capsule",
    sections: [section("preamble", () => SYSTEM, { tag: false })],
    tools: [bash, readFile, writeFile],
  });
}
