import { describe, expect, it } from "vitest";
import {
  capsuleShapeError,
  inlineModules,
  lintCapsule,
  orderFiles,
  resolveImport,
} from "../src/capsule";

const SERVER = `import { capsule, query, table, string } from "lakebed/server";
import type { NewTodo } from "../shared/types";
export default capsule({ schema: { todos: table({ text: string() }) }, queries: { todos: query(async () => []) } });
`;

describe("resolveImport", () => {
  const files = { "server/index.ts": "", "shared/types.ts": "", "server/util.ts": "" };
  it("resolves relative specs with extensions", () => {
    expect(resolveImport("server/index.ts", "../shared/types", files)).toBe("shared/types.ts");
    expect(resolveImport("server/index.ts", "./util", files)).toBe("server/util.ts");
  });
  it("returns null for bare and missing specs", () => {
    expect(resolveImport("server/index.ts", "lakebed/server", files)).toBeNull();
    expect(resolveImport("server/index.ts", "./nope", files)).toBeNull();
  });
});

describe("orderFiles", () => {
  it("orders dependencies before dependents", () => {
    const files = {
      "server/index.ts": `import "./util";`,
      "server/util.ts": `import "../shared/types";`,
      "shared/types.ts": `export interface X { a: string }`,
    };
    expect(orderFiles("server/index.ts", files)).toEqual([
      "shared/types.ts",
      "server/util.ts",
      "server/index.ts",
    ]);
  });
  it("throws on cycles", () => {
    const files = { "a.ts": `import "./b";`, "b.ts": `import "./a";` };
    expect(() => orderFiles("a.ts", files)).toThrow(/circular/);
  });
});

describe("capsuleShapeError", () => {
  it("requires both entries", () => {
    expect(capsuleShapeError({})).toContain("server/index.ts");
    expect(capsuleShapeError({ "server/index.ts": "" })).toContain("client/index.tsx");
    expect(
      capsuleShapeError({ "server/index.ts": "", "client/index.tsx": "" }),
    ).toBeNull();
  });
  it("rejects unsafe paths", () => {
    expect(
      capsuleShapeError({ "server/index.ts": "", "client/index.tsx": "", "../x": "" }),
    ).toContain("unsafe");
  });
});

describe("lintCapsule", () => {
  const good = {
    "server/index.ts": SERVER,
    "client/index.tsx": `export function App() { return null; }`,
    "shared/types.ts": `export interface NewTodo { text: string }`,
  };
  it("passes a clean capsule", () => {
    expect(lintCapsule(good)).toEqual([]);
  });
  it("flags npm imports and node builtins", () => {
    const problems = lintCapsule({
      ...good,
      "server/index.ts": `import leftpad from "leftpad";\nconst b = Buffer.from("x");\n${SERVER}`,
    });
    expect(problems.some((p) => p.includes("leftpad"))).toBe(true);
    expect(problems.some((p) => p.includes("Node built-ins"))).toBe(true);
  });
  it("flags syntax errors per file", () => {
    const problems = lintCapsule({ ...good, "shared/types.ts": "interface {{{" });
    expect(problems.some((p) => p.includes("shared/types.ts"))).toBe(true);
  });
});

describe("inlineModules", () => {
  it("inlines relative files and stubs bare imports", () => {
    const files = {
      "server/index.ts": `import { capsule } from "lakebed/server";\nimport { helper } from "./util";\nexport default capsule({ h: helper() });`,
      "server/util.ts": `export function helper() { return 1; }`,
    };
    const js = inlineModules("server/index.ts", files, { stubBare: { "lakebed/server": "__stub" } });
    expect(js).toContain("const { capsule } = __stub;");
    expect(js).toContain("function helper()");
    expect(js).toContain("globalThis.__entryDefault = capsule(");
    expect(js).not.toContain("from \"./util\"");
  });
});
