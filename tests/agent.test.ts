import { describe, expect, it } from "vitest";
import { buildFeedback, formatDiagnostics, GO_MODELS, ZEN_MODELS } from "../src/agent";
import type { CapsuleResult } from "../src/capsule";

const base: CapsuleResult = { ok: true, tables: ["todos"], queries: { todos: [] }, logs: [], durationMs: 12 };

describe("formatDiagnostics", () => {
  it("renders tsc-shaped lines with category", () => {
    const out = formatDiagnostics([
      { file: "a.ts", line: 3, column: 5, code: 2322, category: "error", text: "bad" },
    ]);
    expect(out).toBe("a.ts(3,5): error TS2322: bad");
  });

  it("omits the code when there is none", () => {
    const out = formatDiagnostics([
      { file: "a.ts", line: 1, column: 1, code: 0, category: "warning", text: "hmm" },
    ]);
    expect(out).toBe("a.ts(1,1): warning: hmm");
    expect(out).not.toContain("TS0");
  });
});

describe("buildFeedback", () => {
  it("reports a passing build with tables", () => {
    const out = buildFeedback(base);
    expect(out).toContain("build passed");
    expect(out).toContain("todos");
  });

  it("surfaces build errors by name", () => {
    const out = buildFeedback({
      ...base,
      ok: false,
      error: { name: "Shape", message: "missing server/index.ts" },
    });
    expect(out).toContain("Shape: missing server/index.ts");
  });

  it("includes console output and query rows", () => {
    const out = buildFeedback({ ...base, logs: ["log   hello"], queries: { todos: [{ id: "1" }] } });
    expect(out).toContain("console:");
    expect(out).toContain("hello");
    expect(out).toContain("query todos:");
  });

  it("falls back when there is nothing to report", () => {
    const empty = buildFeedback({ ok: false, tables: [], queries: {}, logs: [], durationMs: 1 });
    expect(empty).toBe("build finished with no output");
  });

  it("appends type errors without blocking the passing build", () => {
    const out = buildFeedback({
      ...base,
      diagnostics: [
        {
          file: "server/index.ts",
          line: 41,
          column: 26,
          code: 2339,
          category: "error",
          text: "Property 'patch' does not exist.",
        },
      ],
    });
    expect(out).toContain("build passed");
    expect(out).toContain("type errors:");
    expect(out).toContain("server/index.ts(41,26): error TS2339: Property 'patch' does not exist.");
  });

  it("reports an unfinished checker instead of a clean pass", () => {
    const out = buildFeedback({
      ...base,
      typecheckFailure: { name: "Trap", message: "out of memory" },
    });
    expect(out).toContain("build passed");
    expect(out).toContain("type checker did not finish (Trap): out of memory");
  });
});

describe("gateway model lists", () => {
  it("excludes free-tier models that 403 outside OpenCode", () => {
    for (const m of [...ZEN_MODELS, ...GO_MODELS]) {
      expect(m.endsWith("-free")).toBe(false);
      expect(m).not.toContain("free");
    }
  });

  it("lists only non-empty model ids", () => {
    expect(ZEN_MODELS.length).toBeGreaterThan(0);
    expect(GO_MODELS.length).toBeGreaterThan(0);
  });
});
