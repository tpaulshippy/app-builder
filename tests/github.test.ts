import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDeletableBranch, assertGitCapableToken, assertPushAccess, assertWorkflowScope, deleteBranch, diagnosePushFailure, exchangeCode, getRepo, getTokenScopes, loginUrl, OAUTH_SCOPE, parseGrantedScope, parseRepoRef, probeGitPushDiscovery, remoteUrl, requireEnv, tokenKind, touchesWorkflows } from "../src/github";

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

  it("reads token scopes from the OAuth header, [] when unknowable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("{}", { headers: { "x-oauth-scopes": "repo, workflow" } })),
    );
    expect(await getTokenScopes("tok")).toEqual(["repo", "workflow"]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("{}", { status: 401 })));
    expect(await getTokenScopes("bad")).toEqual([]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("down")));
    expect(await getTokenScopes("tok")).toEqual([]);
  });

  it("probes the git push endpoint without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await probeGitPushDiscovery("tok", "octo", "hello");
    expect(r).toEqual({ status: 200, body: "ok" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://github.com/octo/hello.git/info/refs?service=git-receive-pack");
    expect((init.headers as Record<string, string>).authorization).toMatch(/^Basic /);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("down")));
    expect(await probeGitPushDiscovery("tok", "o", "r")).toEqual({ status: 0, body: "down" });
  });

  it("spots workflow files in the file set", () => {
    expect(touchesWorkflows(["index.html", ".github/workflows/deploy.yml"])).toBe(true);
    expect(touchesWorkflows(["index.html", ".github/README.md"])).toBe(false);
    expect(touchesWorkflows([])).toBe(false);
  });

  it("blames the missing workflow scope when the push touches workflows", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("{}", { headers: { "x-oauth-scopes": "repo" } }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 })),
    );
    const diag = await diagnosePushFailure("tok", {
      login: "tpaulshippy",
      owner: "tpaulshippy",
      repo: "tpaulshippy.com",
      fileKeys: ["index.html", ".github/workflows/pages.yml"],
    });
    expect(diag).toContain("token scopes: repo");
    expect(diag).toContain("Log out and back in");
    expect(diag).toContain("discovery 200");
  });

  it("points at repo rules when scopes are complete and discovery is fine", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("{}", { headers: { "x-oauth-scopes": "repo, workflow" } }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 })),
    );
    const diag = await diagnosePushFailure("tok", {
      login: "u",
      owner: "o",
      repo: "r",
      fileKeys: ["index.html"],
    });
    expect(diag).toContain("token scopes: repo, workflow");
    expect(diag).toContain("repo rule");
  });

  it("falls back to /user when rate_limit carries no scopes", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("{}", { status: 200 }))
        .mockResolvedValueOnce(new Response("{}", { headers: { "x-oauth-scopes": "repo" } })),
    );
    expect(await getTokenScopes("tok")).toEqual(["repo"]);
  });

  it("blocks a workflow-touching push on known-missing scope, never on unknown", () => {
    expect(() =>
      assertWorkflowScope(["repo"], ["index.html", ".github/workflows/deploy.yml"]),
    ).toThrow(/lack `workflow`.*Nothing was committed/);
    expect(() => assertWorkflowScope(["repo", "workflow"], [".github/workflows/x.yml"])).not.toThrow();
    expect(() => assertWorkflowScope([], [".github/workflows/x.yml"])).not.toThrow();
    expect(() => assertWorkflowScope(["repo"], ["index.html"])).not.toThrow();
  });

  it("returns the token and granted scopes from the code exchange", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        Response.json({ access_token: "tok123", scope: "repo,workflow", token_type: "bearer" }),
      ),
    );
    await expect(
      exchangeCode({ clientId: "id", clientSecret: "s", code: "c", redirectUri: "https://x/cb" }),
    ).resolves.toEqual({ token: "tok123", grantedScopes: ["repo", "workflow"] });
  });

  it("parses granted scopes in comma or space form", () => {
    expect(parseGrantedScope("repo,workflow")).toEqual(["repo", "workflow"]);
    expect(parseGrantedScope("repo workflow")).toEqual(["repo", "workflow"]);
    expect(parseGrantedScope("")).toEqual([]);
    expect(parseGrantedScope(undefined)).toEqual([]);
  });

  it("classifies token kinds by prefix without exposing the token", () => {
    expect(tokenKind("gho_abc")).toBe("oauth");
    expect(tokenKind("ghu_abc")).toBe("github-app");
    expect(tokenKind("ghp_abc")).toBe("other");
    expect(tokenKind("")).toBe("missing");
    expect(tokenKind(null)).toBe("missing");
  });

  it("refuses git-incapable GitHub-App credentials up front", () => {
    expect(() => assertGitCapableToken("ghu_abc")).toThrow(/GitHub App credential.*every push 403/);
    expect(() => assertGitCapableToken("gho_abc")).not.toThrow();
  });

  it("names the GitHub-App cause immediately in push diagnostics", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const diag = await diagnosePushFailure("ghu_abc", {
      login: "u",
      owner: "o",
      repo: "r",
      fileKeys: ["index.html"],
    });
    expect(diag).toMatch(/GitHub App credential/);
    // No probing needed: the kind alone decides.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never deletes default branches through promote", () => {
    expect(() => assertDeletableBranch("proto/foo", "main")).not.toThrow();
    // The source repo's actual default is always protected ...
    expect(() => assertDeletableBranch("develop", "main", "develop")).toThrow(/default branch/);
    expect(() => assertDeletableBranch("HEAD", "main", "develop")).toThrow(/HEAD/);
    for (const branch of ["main", "master", "HEAD", ""]) {
      expect(() => assertDeletableBranch(branch, "main")).toThrow();
    }
    // ... but a stale branch that merely shares a common default name is
    // deletable once the real default is known.
    expect(() => assertDeletableBranch("main", "other", "develop")).not.toThrow();
    // Deleting the branch the new repo was just pushed to would strand the
    // promote: the source branch must differ from the destination default.
    expect(() => assertDeletableBranch("main", "main")).toThrow();
    expect(() => assertDeletableBranch("feature", "feature")).toThrow(/matches the new repo/);
  });

  it("deletes the source branch through the refs API", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteBranch("tok", "octo", "hello", "proto/foo")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/octo/hello/git/refs/heads/proto/foo");
    expect(init.method).toBe("DELETE");
    // DELETE 404 + ref really gone: already deleted, promote still succeeded.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("nope", { status: 404 }))
        .mockResolvedValueOnce(new Response("nope", { status: 404 })),
    );
    await expect(deleteBranch("tok", "o", "r", "proto/foo")).resolves.toBeUndefined();
    // DELETE 404 but the ref still reads back: do not call it deleted.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("nope", { status: 404 }))
        .mockResolvedValueOnce(Response.json({ ref: "refs/heads/proto/foo" })),
    );
    await expect(deleteBranch("tok", "o", "r", "proto/foo")).rejects.toThrow(/still exists/);
    // DELETE 404 and the read is itself forbidden: unconfirmed, not success.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("nope", { status: 404 }))
        .mockResolvedValueOnce(new Response("denied", { status: 403 })),
    );
    await expect(deleteBranch("tok", "o", "r", "proto/foo")).rejects.toThrow(/could not be confirmed/);
    // Anything else surfaces with the status, not a bare failure.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("protected", { status: 422 })));
    await expect(deleteBranch("tok", "o", "r", "proto/foo")).rejects.toThrow(/422/);
  });
});
