import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPushAccess, getRepo, loginUrl, OAUTH_SCOPE, parseRepoRef, remoteUrl, requireEnv } from "../src/github";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("builds a login url with repo + workflow scope", () => {
    const raw = loginUrl({ clientId: "id", redirectUri: "https://x/cb", state: "s1" });
    const u = new URL(raw);
    expect(u.hostname).toBe("github.com");
    expect(u.pathname).toBe("/login/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("id");
    expect(u.searchParams.get("redirect_uri")).toBe("https://x/cb");
    expect(u.searchParams.get("scope")).toBe("repo workflow");
    expect(u.searchParams.get("scope")).toBe(OAUTH_SCOPE);
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

  it("reads repo permissions for the push pre-check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        Response.json({
          full_name: "octo/hello",
          private: false,
          default_branch: "main",
          html_url: "https://github.com/octo/hello",
          permissions: { push: false, pull: true, admin: false },
        }),
      ),
    );
    const repo = await getRepo("tok", "octo", "hello");
    expect(repo.permissions).toEqual({ push: false, pull: true, admin: false });
  });

  it("explains expired tokens and invisible repos", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("bad", { status: 401 })));
    await expect(getRepo("tok", "o", "r")).rejects.toThrow(/expired or revoked/);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("nope", { status: 404 })));
    await expect(getRepo("tok", "o", "r")).rejects.toThrow(/no repo o\/r/);
  });

  it("refuses the push pre-check without write access, passes with it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        Response.json({
          full_name: "octo/hello",
          private: false,
          default_branch: "main",
          html_url: "https://github.com/octo/hello",
          permissions: { push: false, pull: true, admin: false },
        }),
      ),
    );
    await expect(assertPushAccess("tok", "octo", "hello", "reader")).rejects.toThrow(
      /can read \(clone\) octo\/hello but cannot push/,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        Response.json({
          full_name: "octo/hello",
          private: false,
          default_branch: "main",
          html_url: "https://github.com/octo/hello",
          permissions: { push: true, pull: true, admin: false },
        }),
      ),
    );
    await expect(assertPushAccess("tok", "octo", "hello", "writer")).resolves.toBeUndefined();
  });

  it("lets the git attempt report when the metadata lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("network down")),
    );
    await expect(assertPushAccess("tok", "o", "r", "u")).resolves.toBeUndefined();
  });
});
