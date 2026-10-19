import { describe, expect, it } from "vitest";
import { inlineLocalAssets, pickPreviewHtml, resolveAssetRef } from "../src/preview-assets";

describe("pickPreviewHtml", () => {
  it("returns null when no html file exists", () => {
    expect(pickPreviewHtml({ "server/index.ts": "" })).toBeNull();
    expect(pickPreviewHtml({})).toBeNull();
  });

  it("prefers the root index.html over nested ones", () => {
    expect(
      pickPreviewHtml({
        "docs/index.html": "d",
        "index.html": "root",
        "examples/index.html": "e",
      }),
    ).toBe("index.html");
  });

  it("falls back to a nested index.html, then the first sorted file", () => {
    expect(pickPreviewHtml({ "docs/index.html": "d", "about.html": "a" })).toBe("docs/index.html");
    expect(pickPreviewHtml({ "b.html": "b", "a.html": "a" })).toBe("a.html");
  });

  it("matches html case-insensitively", () => {
    expect(pickPreviewHtml({ "INDEX.HTML": "x" })).toBe("INDEX.HTML");
  });
});

describe("resolveAssetRef", () => {
  const files = { "index.html": "", "style.css": "", "js/app.js": "", "docs/guide.html": "", "docs/a.css": "" };
  it("resolves same-dir and sub-dir refs", () => {
    expect(resolveAssetRef(files, "index.html", "style.css")).toBe("style.css");
    expect(resolveAssetRef(files, "docs/guide.html", "a.css")).toBe("docs/a.css");
  });
  it("resolves dot and dot-dot segments", () => {
    expect(resolveAssetRef(files, "docs/guide.html", "../style.css")).toBe("style.css");
    expect(resolveAssetRef(files, "index.html", "./style.css")).toBe("style.css");
  });
  it("ignores query strings and fragments", () => {
    expect(resolveAssetRef(files, "index.html", "style.css?v=2")).toBe("style.css");
    expect(resolveAssetRef(files, "index.html", "style.css#x")).toBe("style.css");
  });
  it("passes through external, absolute, and missing refs", () => {
    expect(resolveAssetRef(files, "index.html", "https://cdn/x.css")).toBeNull();
    expect(resolveAssetRef(files, "index.html", "//cdn/x.css")).toBeNull();
    expect(resolveAssetRef(files, "index.html", "data:text/css,x")).toBeNull();
    expect(resolveAssetRef(files, "index.html", "/style.css")).toBeNull();
    expect(resolveAssetRef(files, "index.html", "#top")).toBeNull();
    expect(resolveAssetRef(files, "index.html", "nope.css")).toBeNull();
  });
});

describe("inlineLocalAssets", () => {
  it("inlines same-repo stylesheets and scripts", () => {
    const files = {
      "index.html":
        '<link rel="stylesheet" href="style.css"><script src="js/app.js"></script><h1>hi</h1>',
      "style.css": "h1 { color: red; }",
      "js/app.js": "console.log(1);",
    };
    const out = inlineLocalAssets(files, "index.html", files["index.html"] ?? "");
    expect(out).toContain("<style>h1 { color: red; }</style>");
    expect(out).toContain("<script>console.log(1);<\\/script>");
    expect(out).not.toContain('href="style.css"');
    expect(out).not.toContain('src="js/app.js"');
  });

  it("leaves remote, absolute, and missing refs untouched", () => {
    const html =
      '<link rel="stylesheet" href="https://cdn/x.css">' +
      '<link rel="stylesheet" href="/abs.css">' +
      '<link rel="stylesheet" href="missing.css">' +
      '<link rel="icon" href="fav.ico">' +
      '<script src="https://cdn/x.js"></script>';
    expect(inlineLocalAssets({ "index.html": html }, "index.html", html)).toBe(html);
  });

  it("neutralizes closing tags inside inlined content", () => {
    const files = {
      "index.html": '<script src="evil.js"></script>',
      "evil.js": 'const s = "</script><script>alert(1)</script>";',
    };
    const out = inlineLocalAssets(files, "index.html", files["index.html"] ?? "");
    expect(out).not.toMatch(/<\/script><script>/);
    expect(out).toContain("<\\/script>");
  });

  it("resolves refs relative to nested html files", () => {
    const files = { "docs/guide.html": '<link href="../shared.css" rel=stylesheet>', "shared.css": "x{}" };
    expect(inlineLocalAssets(files, "docs/guide.html", files["docs/guide.html"] ?? "")).toContain(
      "<style>x{}</style>",
    );
  });
});
