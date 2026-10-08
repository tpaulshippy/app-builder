import { describe, expect, it } from "vitest";
import { createAgentBash, execWithSync } from "../src/bash";
import type { Sandbox } from "../src/sandbox";

const SERVER = `import { capsule, query, table, string } from "lakebed/server";
export default capsule({ schema: { todos: table({ text: string() }) }, queries: { todos: query(async () => []) } });
`;
const CLIENT = `export function App() { return null; }`;
const TEST = `describe("todos", () => { it("works", () => { expect(1).toBe(1); }); });`;
const FILES = { "server/index.ts": SERVER, "client/index.tsx": CLIENT, "server/todos.test.ts": TEST };

function fakeSandbox(): Sandbox {
  return {
    run: async () => ({ ok: true, html: "", logs: [], durationMs: 1 }),
    runRaw: async (_js: string, filename = "") => {
      if (filename === "extract.ts") {
        return {
          ok: true,
          result: JSON.stringify({
            name: "T", schema: {}, auth: { requireSignIn: false }, endpoints: {},
            queries: [], mutations: [], actions: [],
          }),
          logs: [],
          durationMs: 1,
        };
      }
      return {
        ok: true,
        result: JSON.stringify({ tables: ["todos"], queries: { todos: [] }, passed: 1, failures: [] }),
        logs: [],
        durationMs: 1,
      };
    },
  };
}

describe("agent bash", () => {
  it("runs standard commands over the seeded files", async () => {
    const bash = await createAgentBash(FILES, { sandbox: fakeSandbox() });
    const out = await execWithSync(bash, FILES, "ls server && cat server/index.ts | head -n 1");
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("index.ts");
    expect(out.stdout).toContain('from "lakebed/server"');
    expect(Object.keys(out.files).sort()).toEqual(Object.keys(FILES).sort());
  });

  it("build runs the capsule and reports tables", async () => {
    const bash = await createAgentBash(FILES, { sandbox: fakeSandbox() });
    const out = await execWithSync(bash, FILES, "build");
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("build passed");
    expect(out.stdout).toContain("todos");
  });

  it("test runs test files", async () => {
    const bash = await createAgentBash(FILES, { sandbox: fakeSandbox() });
    const out = await execWithSync(bash, FILES, "tests");
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("passed");
  });

  it("lint passes a clean capsule", async () => {
    const bash = await createAgentBash(FILES, { sandbox: fakeSandbox() });
    const out = await execWithSync(bash, FILES, "lint");
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("lint passed");
  });

  it("lint reports type diagnostics tsc-style", async () => {
    const bash = await createAgentBash(FILES, {
      sandbox: fakeSandbox(),
      typecheck: async () => ({
        diagnostics: [
          {
            code: 2322, category: "error", text: "Type 'string' is not assignable to type 'number'.",
            file: "server/index.ts", line: 3, column: 32, endLine: 3, endColumn: 39,
            sourceLines: [], related: [],
          },
        ],
      }),
    });
    const out = await execWithSync(bash, FILES, "lint");
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("server/index.ts:3:32 TS2322");
  });

  it("lint reports an unfinished checker as a block, not a pass", async () => {
    const bash = await createAgentBash(FILES, {
      sandbox: fakeSandbox(),
      typecheck: async () => ({
        diagnostics: [],
        failure: { name: "Trap", message: "out of memory", stderr: "" },
      }),
    });
    const out = await execWithSync(bash, FILES, "lint");
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("did not finish");
  });

  it("deploy is blocked by type errors before any network", async () => {
    const bash = await createAgentBash(FILES, {
      sandbox: fakeSandbox(),
      typecheck: async () => ({
        diagnostics: [
          {
            code: 2339, category: "error", text: "Property 'emai' does not exist.",
            file: "server/index.ts", line: 4, column: 19, endLine: 4, endColumn: 23,
            sourceLines: [], related: [],
          },
        ],
      }),
    });
    const out = await execWithSync(bash, FILES, "deploy");
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("deploy blocked by type errors");
    expect(out.stderr).toContain("TS2339");
  });

  it("syncs deletions back to the file map", async () => {
    const bash = await createAgentBash(FILES, { sandbox: fakeSandbox() });
    const out = await execWithSync(bash, FILES, "rm server/todos.test.ts && ls server");
    expect(out.exitCode).toBe(0);
    expect(out.files).not.toHaveProperty("server/todos.test.ts");
    expect(out.files).toHaveProperty("server/index.ts");
  });
});
