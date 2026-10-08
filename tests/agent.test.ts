import { describe, expect, it } from "vitest";
import { buildFeedback } from "../src/agent";
import type { RunResult } from "../src/sandbox";

const base: RunResult = { ok: true, html: "<h1>hi</h1>", logs: [], durationMs: 12 };

describe("buildFeedback", () => {
  it("reports a passing build with render size", () => {
    const out = buildFeedback(base);
    expect(out).toContain("build passed");
    expect(out).toContain(String(base.html.length));
  });

  it("surfaces compile errors", () => {
    const out = buildFeedback({
      ...base,
      ok: false,
      compileError: { message: "unexpected token (line 3)" },
    });
    expect(out).toContain("TypeScript failed to parse");
    expect(out).toContain("unexpected token");
  });

  it("surfaces runtime errors by name", () => {
    const out = buildFeedback({
      ...base,
      ok: false,
      error: { name: "ReferenceError", message: "x is not defined" },
    });
    expect(out).toContain("ReferenceError: x is not defined");
  });

  it("includes console output", () => {
    const out = buildFeedback({ ...base, logs: ["log   hello"] });
    expect(out).toContain("console:");
    expect(out).toContain("hello");
  });

  it("reports type diagnostics with category and code", () => {
    const out = buildFeedback({
      ...base,
      ok: false,
      diagnostics: [
        {
          code: 2322,
          category: "error",
          text: "Type 'string' is not assignable to type 'number'.",
          file: "index.ts",
          line: 2,
          column: 32,
          endLine: 2,
          endColumn: 39,
          sourceLines: [],
          related: [],
        },
      ],
    });
    expect(out).toContain("index.ts(2,32): error TS2322");
    expect(out).not.toContain("build passed");
  });

  it("omits the TS code when a diagnostic has none", () => {
    const out = buildFeedback({
      ...base,
      ok: false,
      diagnostics: [
        {
          code: 0,
          category: "warning",
          text: "Something looks off.",
          file: "index.ts",
          line: 1,
          column: 1,
          endLine: 1,
          endColumn: 2,
          sourceLines: [],
          related: [],
        },
      ],
    });
    expect(out).toContain("warning");
    expect(out).not.toContain("TS0");
  });

  it("surfaces a failed type checker distinctly from diagnostics", () => {
    const out = buildFeedback({
      ...base,
      ok: false,
      typecheckError: { name: "Trap", message: "out of memory", stderr: "" },
    });
    expect(out).toContain("Type checker failed: Trap: out of memory");
  });

  it("falls back when there is nothing to report", () => {
    const out = buildFeedback({ ok: true, html: "", logs: [], durationMs: 1 });
    // ok with no compile error still reports a pass; empty+failed reports fallback
    expect(out).toContain("build passed");
    const empty = buildFeedback({
      ok: false,
      html: "",
      logs: [],
      durationMs: 1,
    });
    expect(empty).toBe("build finished with no output");
  });
});
