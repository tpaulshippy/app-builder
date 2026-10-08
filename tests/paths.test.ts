import { describe, expect, it } from "vitest";
import { isSafePath } from "../src/paths";

describe("isSafePath", () => {
  it.each(["index.ts", "a.ts", "dir/file.ts", "a-b_c/d.e-f.ts", "./rel.ts"])(
    "accepts %s",
    (p) => {
      expect(isSafePath(p)).toBe(true);
    },
  );

  it.each([
    "",
    "../evil.ts",
    "a/../b.ts",
    "..",
    "/abs.ts",
    "a b.ts",
    "a;b.ts",
    "a$(x).ts",
    "C:\\win.ts",
  ])("rejects %s", (p) => {
    expect(isSafePath(p)).toBe(false);
  });
});
