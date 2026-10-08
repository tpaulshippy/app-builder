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
