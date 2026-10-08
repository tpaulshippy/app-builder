import { describe, expect, it, vi } from "vitest";
import { buildDeployEnvelope, bundleEntry, deployCapsule, deployLint } from "../src/lakebed";
import type { Sandbox } from "../src/sandbox";

const SERVER = `import { boolean, capsule, mutation, query, string, table, userId } from "lakebed/server";
export default capsule({
  schema: {
    todos: table({ text: string(), done: boolean().default(false), ownerId: userId() }).index("by_owner", ["ownerId"]),
  },
  queries: { todos: query(async (ctx) => []) },
  mutations: { addTodo: mutation(async (ctx, text: string) => "id_1") },
});
`;
const CLIENT = `import { createClient } from "lakebed/client";
export function App() { return <main>hi</main>; }
`;
const FILES = { "server/index.ts": SERVER, "client/index.tsx": CLIENT };

const EXTRACT_JSON = JSON.stringify({
  name: "Todo",
  schema: {
    todos: {
      kind: "table",
      fields: {
        text: { kind: "string" },
        done: { kind: "boolean", defaultValue: false },
        ownerId: { kind: "userId" },
      },
      indexes: [{ fields: ["ownerId"], name: "by_owner" }],
    },
  },
  auth: { requireSignIn: false },
  endpoints: {},
  queries: ["todos"],
  mutations: ["addTodo"],
  actions: [],
});

function fakeSandbox(extractJson = EXTRACT_JSON): Sandbox {
  return {
    run: async () => ({ ok: true, html: "", logs: [], durationMs: 1 }),
    runRaw: async () => ({ ok: true, result: extractJson, logs: [], durationMs: 1 }),
  };
}

/** Canned vendor runtime: satisfies the bundler without network. */
const VENDOR = {
  "__vendor/lakebed/server.js": `import { table as t } from "./database/schema.js";
export { t as table };
export const capsule = (d) => d;
export const query = (h) => h;
export const mutation = (h) => h;
export const string = () => ({ kind: "string" });
export const boolean = () => ({ kind: "boolean", default(v) { return { ...this, defaultValue: v }; } });
export const userId = () => ({ kind: "userId" });
export const endpoint = (r, h) => ({ handler: h, kind: "endpoint", method: r.method, path: r.path });
export const json = (v) => v;
`,
  "__vendor/lakebed/database/schema.js": `export const table = (fields) => ({ fields, indexes: [], kind: "table", index(n, f) { return { ...this, indexes: [...this.indexes, { fields: [...f], name: n }] }; } });`,
};

const envelopeOpts = { vendor: VENDOR };

describe("deployLint", () => {
  it("passes a clean capsule", () => {
    expect(deployLint(FILES)).toEqual([]);
  });
  it("flags while loops and server fetch", () => {
    const out = deployLint({
      ...FILES,
      "server/index.ts": `${SERVER}\nwhile (true) {}\nfetch("https://x");`,
    });
    expect(out.some((d) => d.message.includes("while"))).toBe(true);
    expect(out.some((d) => d.message.includes("fetch"))).toBe(true);
  });
});

describe("bundleEntry", () => {
  it("keeps bare imports and inlines relative files", () => {
    const js = bundleEntry("server/index.ts", FILES);
    expect(js).toContain('from "lakebed/server"');
    expect(js).toContain("export default capsule(");
  });
  it("transforms tsx with the h pragma", () => {
    const js = bundleEntry("client/index.tsx", FILES, { jsx: true });
    expect(js).toContain("h(");
  });
});

describe("buildDeployEnvelope", () => {
  it("assembles a valid envelope", async () => {
    const { artifact, clientBundle } = await buildDeployEnvelope(FILES, fakeSandbox(), envelopeOpts);
    expect(artifact.format).toBe("lakebed.capsule.artifact.v2");
    expect((artifact.server as any).source.entry).toBe("/server.mjs");
    expect((artifact.client as any).entry).toBe("/client.js");
    expect((artifact.server as any).schema.todos.fields.text).toMatchObject({ kind: "string" });
    expect((artifact.server as any).queries).toEqual({ todos: { op: "source" } });
    // server bundle is embedded base64 and non-empty
    expect(((artifact.server as any).source.bundle as string).length).toBeGreaterThan(100);
    expect(clientBundle.length).toBeGreaterThan(50);
    // source manifest covers every file
    expect((artifact.source as any).files.map((f: any) => f.path)).toEqual([
      "client/index.tsx",
      "server/index.ts",
    ]);
  });

  it("rejects a bad schema with file-scoped diagnostics", async () => {
    const badExtract = JSON.stringify({
      name: "Todo",
      schema: { todos: {} },
      auth: { requireSignIn: false },
      endpoints: {},
      queries: [],
      mutations: [],
      actions: [],
    });
    await expect(buildDeployEnvelope(FILES, fakeSandbox(badExtract))).rejects.toThrow(/server\/index\.ts/);
  });
});

describe("deployCapsule", () => {
  it("posts to the anonymous route without a token", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json({ deployId: "dep_1", url: "https://x.lakebed.app", expiresAt: "tomorrow", claimed: false }),
    );
    const result = await deployCapsule(FILES, fakeSandbox(), { fetch: fetchMock as any, vendor: VENDOR });
    expect(result).toMatchObject({ ok: true, url: "https://x.lakebed.app", deployId: "dep_1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error("expected a deploy request");
    const [url, init] = firstCall;
    expect(url).toBe("https://api.lakebed.dev/v1/anonymous-deploys");
    expect(init.headers).not.toHaveProperty("authorization");
    expect(JSON.parse(init.body).clientVersion).toBeTruthy();
  });

  it("posts to the owned route with a token", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json({ deployId: "dep_2", url: "https://y.lakebed.app", claimed: true }),
    );
    const result = await deployCapsule(FILES, fakeSandbox(), { token: "lkb_x", fetch: fetchMock as any, vendor: VENDOR });
    expect(result).toMatchObject({ ok: true, claimed: true });
    const ownedCall = fetchMock.mock.calls[0];
    if (!ownedCall) throw new Error("expected a deploy request");
    expect(ownedCall[0]).toBe("https://api.lakebed.dev/v1/deploys");
    expect((ownedCall[1].headers as Record<string, string>).authorization).toBe("Bearer lkb_x");
  });

  it("surfaces rejections without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("bad artifact", { status: 422 }));
    const result = await deployCapsule(FILES, fakeSandbox(), { fetch: fetchMock as any, vendor: VENDOR });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("422");
  });
});
