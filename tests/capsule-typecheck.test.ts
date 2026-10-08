import { describe, expect, it, vi } from "vitest";
import { __clearDeclarationCache, buildCapsuleProject, fetchDeclarations } from "../src/capsule-typecheck";

const SERVER = `import { capsule } from "lakebed/server";
export default capsule({ schema: {}, queries: {}, mutations: {} });
`;
const CLIENT = `export function App() { return null; }`;
const FILES = { "server/index.ts": SERVER, "client/index.tsx": CLIENT };

/** Minimal .d.ts web: server.d.ts pulls one relative file. */
function dtsFetch() {
  return vi.fn(async (url: string) => {
    if (url.endsWith("server.d.ts")) {
      return new Response(`import type { X } from "./x.js";\nexport declare const capsule: (d: X) => X;\n`);
    }
    if (url.endsWith("x.d.ts")) {
      return new Response(`export declare type X = object;\n`);
    }
    if (url.endsWith("client.d.ts")) {
      return new Response(`export declare const createClient: () => void;\n`);
    }
    if (url.endsWith("package.json")) {
      return new Response(`{}`);
    }
    return new Response("not found", { status: 404 });
  });
}

describe("fetchDeclarations", () => {
  it("follows relative .d.ts imports and maps .js to .d.ts", async () => {
    const out = await fetchDeclarations(dtsFetch() as any);
    expect(out["/app/node_modules/lakebed/dist/server.d.ts"]).toContain("capsule");
    // ./x.js resolved to x.d.ts relative to the importing file
    expect(out["/app/node_modules/lakebed/dist/x.d.ts"]).toBeDefined();
  });

  it("skips 404s so the checker reports TS2307 instead", async () => {
    __clearDeclarationCache();
    const fetchMock = vi.fn(async () => new Response("nope", { status: 404 }));
    const out = await fetchDeclarations(fetchMock as any);
    expect(Object.keys(out)).toEqual([]);
  });
});

describe("buildCapsuleProject", () => {
  it("assembles capsule files, tsconfig, test globals, and declarations", async () => {
    const project = await buildCapsuleProject(FILES, dtsFetch() as any);
    expect(project["/app/server/index.ts"]).toBe(SERVER);
    expect(project["/app/client/index.tsx"]).toBe(CLIENT);
    const tsconfig = JSON.parse(project["/app/tsconfig.json"] ?? "{}");
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.jsx).toBe("react-jsx");
    expect(project["/app/__test.d.ts"]).toContain("__testCtx");
  });

  it("excludes virtual and secret files", async () => {
    const project = await buildCapsuleProject(
      { ...FILES, "__lakebed/client-entry.tsx": "x", "lakebed.json": "{}", ".env.lakebed.server": "K=V" },
      dtsFetch() as any,
    );
    expect(project["/app/__lakebed/client-entry.tsx"]).toBeUndefined();
    expect(project["/app/lakebed.json"]).toBeUndefined();
    expect(project["/app/.env.lakebed.server"]).toBeUndefined();
  });
});
