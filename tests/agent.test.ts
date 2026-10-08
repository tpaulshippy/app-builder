import { describe, expect, it } from "vitest";
import { buildFeedback, formatDiagnostics } from "../src/agent";
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
});
