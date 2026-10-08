import { describe, expect, it } from "vitest";
import { transform } from "sucrase";
import {
  NEEDS_INIT,
  buildInitProbe,
  buildMutateProbe,
  buildQueryProbe,
  fileKey,
  initAppRuntime,
  mutateAppRuntime,
  queryAppRuntime,
} from "../src/app-runtime";
import { APP_SHIM_JS } from "../src/app-shim";
import { buildAppBundle } from "../src/lakebed";
import type { Sandbox } from "../src/sandbox";

const SERVER = `import { boolean, capsule, mutation, query, string, table, userId } from "lakebed/server";
export default capsule({
  schema: { todos: table({ text: string(), done: boolean().default(false), ownerId: userId() }) },
  queries: { todos: query(async (ctx) => [{ id: "1", text: "hi" }]) },
  mutations: { addTodo: mutation(async (ctx, text: string) => "id_2") },
});
`;
const CLIENT = `import { createClient } from "lakebed/client";
export function App() { return null; }
`;
const FILES = { "server/index.ts": SERVER, "client/index.tsx": CLIENT };

const STATE_JSON = JSON.stringify({ tables: ["todos"], queries: { todos: [{ id: "1", text: "hi" }] } });

/** Fake sandbox: canned results, capturing the probe source for inspection. */
function fakeSandbox(result: unknown, seen: string[] = []): Sandbox {
  return {
    run: async () => ({ ok: true, html: "", logs: [], durationMs: 1 }),
    runRaw: async (js: string) => {
      seen.push(js);
      return { ok: true, result, logs: [], durationMs: 1 };
    },
  };
}

describe("fileKey", () => {
  it("is stable regardless of key order", () => {
    const a = { "a.ts": "1", "b.ts": "2" };
    expect(fileKey({ "b.ts": "2", "a.ts": "1" })).toBe(fileKey(a));
  });
  it("changes when content changes", () => {
    expect(fileKey({ "a.ts": "1" })).not.toBe(fileKey({ "a.ts": "2" }));
  });
});

describe("initAppRuntime", () => {
  it("rejects a missing server entry before touching the sandbox", async () => {
    const seen: string[] = [];
    const r = await initAppRuntime({ "client/index.tsx": CLIENT }, fakeSandbox(STATE_JSON, seen));
    expect(r.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });
  it("initializes the stashed runtime and answers initial state", async () => {
    const seen: string[] = [];
    const r = await initAppRuntime(FILES, fakeSandbox(STATE_JSON, seen));
    expect(r).toEqual({ ok: true, tables: ["todos"], queries: { todos: [{ id: "1", text: "hi" }] } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("globalThis.__app");
    expect(seen[0]).toContain("globalThis.__lakebedServer");
  });
  it("surfaces isolate errors", async () => {
    const sb: Sandbox = {
      run: async () => ({ ok: true, html: "", logs: [], durationMs: 1 }),
      runRaw: async () => ({ ok: false, result: null, logs: [], error: { name: "Timeout", message: "slow" }, durationMs: 1 }),
    };
    expect(await initAppRuntime(FILES, sb)).toEqual({ ok: false, error: { name: "Timeout", message: "slow" } });
  });
});

describe("queryAppRuntime", () => {
  it("answers state without rebundling", async () => {
    const seen: string[] = [];
    const r = await queryAppRuntime(fakeSandbox(STATE_JSON, seen));
    expect(r).toEqual({ ok: true, tables: ["todos"], queries: { todos: [{ id: "1", text: "hi" }] } });
    expect(seen[0]).not.toContain("lakebedServer");
  });
  it("reports needsInit when the runtime was lost", async () => {
    expect(await queryAppRuntime(fakeSandbox(JSON.stringify({ needsInit: true })))).toBe(NEEDS_INIT);
  });
});

describe("mutateAppRuntime", () => {
  it("embeds call arguments quoting-safely and answers refreshed state", async () => {
    const seen: string[] = [];
    const args = [`a"b\nc</script>`];
    const r = await mutateAppRuntime(
      fakeSandbox(JSON.stringify({ result: "id_2", tables: ["todos"], queries: { todos: [] } }), seen),
      "mutation",
      "addTodo",
      args,
    );
    expect(r).toEqual({ ok: true, result: "id_2", tables: ["todos"], queries: { todos: [] } });
    expect(seen[0]).toContain(JSON.stringify({ kind: "mutation", name: "addTodo", args }));
  });
  it("reports needsInit when the runtime was lost", async () => {
    expect(
      await mutateAppRuntime(fakeSandbox(JSON.stringify({ needsInit: true })), "mutation", "addTodo", []),
    ).toBe(NEEDS_INIT);
  });
  it("buildMutateProbe supports actions", () => {
    expect(buildMutateProbe("action", "send", [1])).toContain('"kind":"action"');
    expect(buildQueryProbe()).toContain("needsInit");
    expect(buildInitProbe(FILES)).toContain("__entryDefault");
  });
});

describe("buildAppBundle", () => {
  const SHIM = "https://example.test/api/app-shim.js";
  it("bundles the client against the shim URL", () => {
    const bundle = buildAppBundle(FILES, SHIM);
    expect(bundle).toContain(SHIM);
    expect(bundle).toContain("h(App");
    expect(bundle).not.toMatch(/from\s+["']lakebed\/client["']/);
    expect(bundle).toContain("esm.sh/preact@10.28.0");
    // The bundle must parse as a module: sucrase parses, it does not check.
    expect(() => transform(bundle, { transforms: [] })).not.toThrow();
  });
  it("refuses client imports of lakebed/server", () => {
    expect(() =>
      buildAppBundle({ ...FILES, "client/extra.ts": `import { query } from "lakebed/server";` }, SHIM),
    ).toThrow(/must not import lakebed\/server/);
  });
});

describe("APP_SHIM_JS", () => {
  it("exports the client surface capsules import", () => {
    for (const name of [
      "createClient", "useQuery", "useMutation", "useAction", "usePaginatedQuery",
      "ErrorBoundary", "Router", "Routes", "Route", "Link", "navigate",
      "useLocation", "useNavigate", "useParams", "useAuth", "SignInWithGoogle",
      "signInWithGoogle", "signOut", "retryAuth", "getIdentity",
      "decodeIdentityClaims", "canAccessApp", "storage",
    ]) {
      expect(APP_SHIM_JS).toMatch(new RegExp(`export\\s+(function|class|var|const)\\s+${name}\\b`));
    }
  });
  it("parses as a module", () => {
    expect(() => transform(APP_SHIM_JS, { transforms: [] })).not.toThrow();
  });
  it("shares the bundle's preact instance", () => {
    expect(APP_SHIM_JS).toContain("esm.sh/preact@10.28.0/es2022/preact.mjs");
    expect(APP_SHIM_JS).toContain("esm.sh/preact@10.28.0/es2022/hooks.mjs");
  });
});
