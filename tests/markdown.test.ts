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

  it("renders unclosed fences as code (streaming)", () => {
    const out = markdownToHtml("```js\nconst a = 1;\nmore");
    expect(out).toContain("<pre><code");
  });

  it("renders links safely and blocks javascript: URLs", () => {
    const ok = markdownToHtml("[t](https://example.com)");
    expect(ok).toContain('<a href="https://example.com"');
    expect(markdownToHtml("[t](javascript:alert(1))")).not.toContain("<a");
    expect(markdownToHtml("![alt](https://example.com/x.png)")).not.toContain("<img");
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
