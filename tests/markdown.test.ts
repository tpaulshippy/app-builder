import { describe, expect, it } from "vitest";
import { markdownToHtml } from "../src/markdown";

describe("markdownToHtml", () => {
  it("renders paragraphs and line breaks", () => {
    expect(markdownToHtml("hello")).toContain("<p>hello</p>");
    expect(markdownToHtml("a\nb")).toContain("a<br>b");
  });

  it("escapes raw HTML", () => {
    const out = markdownToHtml('<script>alert(1)</script>');
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("renders headings, bold, italic, strike", () => {
    expect(markdownToHtml("# Hi")).toContain("<h1>Hi</h1>");
    expect(markdownToHtml("## Hi")).toContain("<h2>Hi</h2>");
    expect(markdownToHtml("**b**")).toContain("<strong>b</strong>");
    expect(markdownToHtml("*i*")).toContain("<em>i</em>");
    expect(markdownToHtml("~~s~~")).toContain("<del>s</del>");
  });

  it("renders inline code and fenced blocks escaped", () => {
    expect(markdownToHtml("`a<b`")).toContain("<code>a&lt;b</code>");
    const out = markdownToHtml("```js\nif (a < b) {}\n```");
    expect(out).toContain("<pre><code");
    expect(out).toContain("if (a &lt; b)");
  });

  it("renders unclosed fences as code with content (streaming)", () => {
    const out = markdownToHtml("```js\nconst a = 1;\nmore");
    expect(out).toContain("<pre><code");
    expect(out).toContain("const a = 1;");
    expect(out).toContain("more");
  });

  it("renders links with opener protection and mailto, blocks unsafe schemes", () => {
    const ok = markdownToHtml("[t](https://example.com)");
    expect(ok).toContain('<a href="https://example.com" target="_blank" rel="noopener">t</a>');
    expect(markdownToHtml("[m](mailto:a@b.com)")).toContain('<a href="mailto:a@b.com"');
    expect(markdownToHtml("[t](javascript:alert(1))")).not.toContain("<a");
    expect(markdownToHtml("[t](data:text/html,hi)")).not.toContain("<a");
    expect(markdownToHtml("[t](ftp://example.com/x)")).not.toContain("<a");
  });

  it("renders images as safe links, never img tags", () => {
    const out = markdownToHtml("![alt](https://example.com/x.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain('<a href="https://example.com/x.png" target="_blank" rel="noopener">alt</a>');
  });

  it("escapes query-string URLs exactly once", () => {
    const out = markdownToHtml("[q](https://ex.com/?a=1&b=2)");
    expect(out).toContain('href="https://ex.com/?a=1&amp;b=2"');
    expect(out).not.toContain("&amp;amp;");
  });

  it("does not let emphasis rewrite hrefs", () => {
    const out = markdownToHtml("[t](https://ex.com/__init__)");
    expect(out).toContain('href="https://ex.com/__init__"');
    expect(out).not.toContain("<strong>init</strong>");
  });

  it("supports titled links and autolinks with query strings", () => {
    expect(markdownToHtml('[t](https://ex.com "title")')).toContain('href="https://ex.com"');
    const auto = markdownToHtml("<https://ex.com/?a=1&b=2>");
    expect(auto).toContain('href="https://ex.com/?a=1&amp;b=2"');
  });

  it("linkifies a URL after inline code", () => {
    const out = markdownToHtml("`code` see https://example.com/a");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain('<a href="https://example.com/a"');
  });

  it("keeps inline code inside link labels", () => {
    const out = markdownToHtml("[`code` label](https://example.com)");
    expect(out).toContain('<a href="https://example.com"');
    expect(out).toContain("<code>code</code>");
    expect(out).not.toMatch(/\x01\d+\x01/);
  });

  it("does not apply emphasis to bare URL text", () => {
    const out = markdownToHtml("see https://ex.com/a*b for details");
    expect(out).toContain('<a href="https://ex.com/a*b"');
    expect(out).not.toContain("<em>");
  });

  it("linkifies bare https URLs once", () => {
    const out = markdownToHtml("see https://example.com/a for details");
    expect(out.match(/<a href="https:\/\/example\.com\/a"/g)?.length).toBe(1);
  });

  it("renders lists, quotes, and hr", () => {
    expect(markdownToHtml("- a\n- b")).toContain("<ul>");
    expect(markdownToHtml("1. a\n2. b")).toContain("<ol>");
    expect(markdownToHtml("> quoted")).toContain("<blockquote>");
    expect(markdownToHtml("---")).toContain("<hr>");
  });

  it("does not emit script terminators or raw tags", () => {
    const out = markdownToHtml("# t\n\nhello **world**\n\n- a\n\n```\nx\n```\n\n[y](https://e.com)");
    expect(out).not.toMatch(/<\/script/i);
    expect(out).not.toContain("<script");
  });
});
