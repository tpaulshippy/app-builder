/**
 * Slice (b): the capsule workspace as Pi tools.
 *
 * The same three tools as the manual turn loop — `bash` (just-bash shell
 * with the build/tests/lint/deploy dev cycle), `read_file`, `write_file` —
 * as Pi `ToolRegistration`s closing over the session, plus the capsule
 * instructions as the `preamble` prompt section. Execution semantics
 * (report text, ok flags, follow-up builds) come from the shared
 * `execCapsuleTool`, so the manual loop and Pi-owned generations agree.
 *
 * Replay policy: `read_file` and whole-file `write_file` are safe to rerun
 * after a crash; `bash` runs arbitrary code with side effects and must
 * never rerun (the model gets an interrupted result instead). `bash` is
 * also sequential: the shell FS is shared, so one round's bash calls run
 * in order (one sequential call makes its whole round sequential).
 *
 * Open item: no approval gate. `deploy` runs inside `bash` like any other
 * command; a `beforeTool` approval hook needs a UI round-trip that does not
 * exist yet (see PR notes).
 */

import {
  defineExtension,
  defineTool,
  section,
  type Extension,
} from "@earendil-works/pi-durable";
import { SYSTEM, type SessionApi } from "./agent";
import { execCapsuleTool } from "./capsule-tool-exec";
import { PI_TOOLS } from "./pi-opencode";

function toolDef(name: "bash" | "read_file" | "write_file"): (typeof PI_TOOLS)[number] {
  const def = PI_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`unknown capsule tool: ${name}`);
  return def;
}

/** Pi extension for one capsule session. Install on the Harness registry. */
export function createCapsuleExtension(session: SessionApi): Extension {
  const bashDef = toolDef("bash");
  const readDef = toolDef("read_file");
  const writeDef = toolDef("write_file");

  const bash = defineTool({
    name: bashDef.name,
    description: bashDef.description,
    parameters: bashDef.parameters,
    replay: "unsafe",
    executionMode: "sequential",
    execute: async (args) => {
      const outcome = await execCapsuleTool(
        session,
        await session.getFiles(),
        "bash",
        args as unknown as Record<string, unknown>,
      );
      await session.setFiles(outcome.files);
      return { content: [{ type: "text", text: outcome.output }], isError: !outcome.ok };
    },
  });

  const readFile = defineTool({
    name: readDef.name,
    description: readDef.description,
    parameters: readDef.parameters,
    replay: "safe",
    execute: async (args) => {
      const outcome = await execCapsuleTool(
        session,
        await session.getFiles(),
        "read_file",
        args as unknown as Record<string, unknown>,
      );
      return { content: [{ type: "text", text: outcome.output }], isError: !outcome.ok };
    },
  });

  const writeFile = defineTool({
    name: writeDef.name,
    description: writeDef.description,
    parameters: writeDef.parameters,
    replay: "safe",
    // Read-modify-write on the shared file map: parallel writes would each
    // read the same snapshot and the later setFiles would drop the earlier
    // edit. Sequential, like bash.
    executionMode: "sequential",
    execute: async (args) => {
      const outcome = await execCapsuleTool(
        session,
        await session.getFiles(),
        "write_file",
        args as unknown as Record<string, unknown>,
      );
      await session.setFiles(outcome.files);
      return { content: [{ type: "text", text: outcome.output }], isError: !outcome.ok };
    },
  });

  return defineExtension({
    name: "capsule",
    sections: [section("preamble", () => SYSTEM, { tag: false })],
    tools: [bash, readFile, writeFile],
  });
}
