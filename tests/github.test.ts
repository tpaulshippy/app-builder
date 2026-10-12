import { describe, expect, it } from "vitest";
import { loginUrl, parseRepoRef, remoteUrl, requireEnv } from "../src/github";

describe("github helpers", () => {
  it("parses owner/repo refs", () => {
    expect(parseRepoRef("octo/hello")).toEqual({ owner: "octo", repo: "hello" });
    expect(parseRepoRef("https://github.com/octo/hello.git")).toEqual({
      owner: "octo",
      repo: "hello",
    });
  });

  it("tolerates common paste forms", () => {
    expect(parseRepoRef("http://github.com/octo/hello")).toEqual({ owner: "octo", repo: "hello" });
    expect(parseRepoRef("www.github.com/octo/hello")).toEqual({ owner: "octo", repo: "hello" });
    expect(parseRepoRef("https://github.com/octo/hello/")).toEqual({ owner: "octo", repo: "hello" });
    expect(parseRepoRef("git@github.com:octo/hello.git")).toEqual({ owner: "octo", repo: "hello" });
    expect(parseRepoRef("  octo/hello  ")).toEqual({ owner: "octo", repo: "hello" });
  });

  it("rejects malformed refs", () => {
    expect(() => parseRepoRef("just-a-name")).toThrow();
    expect(() => parseRepoRef("a/b/c")).toThrow();
    expect(() => parseRepoRef("../evil")).toThrow();
  });

  it("builds remote urls", () => {
    expect(remoteUrl("octo", "hello")).toBe("https://github.com/octo/hello.git");
  });

  it("builds a login url with repo scope", () => {
    const u = new URL(
      loginUrl({ clientId: "id", redirectUri: "https://x/cb", state: "s1" }),
    );
    expect(u.hostname).toBe("github.com");
    expect(u.searchParams.get("client_id")).toBe("id");
    expect(u.searchParams.get("scope")).toBe("repo");
    expect(u.searchParams.get("state")).toBe("s1");
  });

  it("requires OAuth env", () => {
    expect(() => requireEnv({})).toThrow("GITHUB_CLIENT_ID");
    expect(() => requireEnv({ GITHUB_CLIENT_ID: "x" })).toThrow("GITHUB_CLIENT_SECRET");
    expect(requireEnv({ GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "b" })).toEqual({
      clientId: "a",
      clientSecret: "b",
    });
  });
});
