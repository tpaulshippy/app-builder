/**
 * Branch picker + New branch for branch-per-prototype flow (#28).
 *
 * Unit: branch-name validation, `branch -a` parsing, and switch-target
 * resolution are pure and fully covered here. Local git flows (list/switch/
 * delete, dirty-checkout refusal) run against an in-memory just-git repo;
 * createBranch is covered for name validation (which runs before any network
 * use), not the push itself.
 * API: the new /api/git/branches + /api/git/branch/* endpoints sit behind the
 * login gate and refuse mid-turn with 409 like Create/Commit.
 */
import { describe, expect, it, vi } from "vitest";
import { createGit, MemoryFileSystem } from "just-git";
import {
  createBranch,
  deleteBranch,
  listBranches,
  parseBranchLines,
  parseBranchList,
  resolveSwitchTarget,
  switchBranch,
  validateBranchName,
  snapshotGitDir,
  WORKTREE,
} from "../src/gitops";

vi.mock("../src/session", () => ({
  AppSession: class MockAppSession {},
}));

import worker from "../src/index";
import type { Env } from "../src/index";

const IDENTITY = { name: "t", email: "t@t" };
const META = { owner: "o", repo: "r", branch: "main", remoteUrl: "https://github.com/o/r.git" };

async function localRepo() {
  const fs = new MemoryFileSystem();
  const git = createGit({ fs, cwd: "/repo", identity: { ...IDENTITY, locked: true } });
  await git.exec("init");
  await fs.writeFile(`${WORKTREE}/index.html`, "v1\n");
  await git.exec("add -A");
  await git.exec("commit -m init");
  await git.exec("checkout -b proto/alpha");
  await fs.writeFile(`${WORKTREE}/index.html`, "alpha\n");
  await git.exec("add -A");
  await git.exec("commit -m alpha");
  await git.exec("checkout main");
  const snap = await snapshotGitDir(fs);
  return { snap, files: { "index.html": "v1\n" } };
}

describe("validateBranchName", () => {
  it("accepts proto/* and plain names", () => {
    expect(validateBranchName("proto/my-prototype")).toBe("proto/my-prototype");
    expect(validateBranchName("  main  ")).toBe("main");
    expect(validateBranchName("feature/a.b_c-d")).toBe("feature/a.b_c-d");
  });

  it("rejects empty, traversal, ref-log syntax, and leading dashes", () => {
    for (const bad of ["", "   ", "..", "a..b", "proto/../x", "@{1}", "HEAD", "@", "a b", "a~1", "a^", "a:b", "a?b", "a*b", "a[1]", ".lock", "x.lock", "/lead", "trail/", "a//b", ".dot", "dot.", "-main", "--force", "-proto/x"]) {
      expect(() => validateBranchName(bad), bad).toThrow(/branch name|must not start with a dash/);
    }
  });
});

describe("parseBranchList", () => {
  it("parses current + local + remote entries, skipping the HEAD symlink", () => {
    const out = "* main\n  proto/alpha\n  remotes/origin/main\n  remotes/origin/HEAD -> origin/main\n  remotes/origin/proto/beta\n";
    const { current, branches } = parseBranchList(out);
    expect(current).toBe("main");
    const byName = Object.fromEntries(branches.map((b) => [b.name, b]));
    expect(byName["main"]).toMatchObject({ current: true, remote: false });
    expect(byName["proto/alpha"]).toMatchObject({ current: false, remote: false });
    expect(byName["origin/main"]).toMatchObject({ remote: true });
    expect(byName["origin/proto/beta"]).toMatchObject({ remote: true });
    expect(byName["remotes/origin/HEAD"]).toBeUndefined();
  });

  it("marks a local branch that also exists remotely as local, not remote", () => {
    const { branches } = parseBranchList("  main\n  remotes/origin/main\n");
    expect(branches.find((b) => b.name === "main")).toMatchObject({ remote: false });
    expect(branches.find((b) => b.name === "origin/main")).toMatchObject({ remote: true });
  });

  it("returns null current for empty output", () => {
    expect(parseBranchList("")).toEqual({ current: null, branches: [] });
  });

  it("skips a detached HEAD instead of listing it as a branch", () => {
    const { current, branches } = parseBranchList("* (HEAD detached at afe22f3)\n  main\n");
    expect(current).toBeNull();
    expect(branches.map((b) => b.name)).toEqual(["main"]);
  });
});

describe("parseBranchLines", () => {
  it("keeps names verbatim and marks the current branch", () => {
    // A local branch literally named `remotes/foo` stays local here: the
    // local-vs-remote decision is made by which listing it came from, never
    // by the name prefix.
    const { current, branches } = parseBranchLines("* main\n  remotes/foo\n  proto/a\n", false);
    expect(current).toBe("main");
    expect(branches).toEqual([
      { name: "main", current: true, remote: false },
      { name: "proto/a", current: false, remote: false },
      { name: "remotes/foo", current: false, remote: false },
    ]);
  });

  it("parses remote listings and skips symlinks and detached HEAD", () => {
    const { current, branches } = parseBranchLines(
      "  origin/main\n  origin/HEAD -> origin/main\n  origin/proto/beta\n",
      true,
    );
    expect(current).toBeNull();
    expect(branches).toEqual([
      { name: "origin/main", current: false, remote: true },
      { name: "origin/proto/beta", current: false, remote: true },
    ]);
    const detached = parseBranchLines("* (HEAD detached at afe22f3)\n  main\n", false);
    expect(detached.current).toBeNull();
    expect(detached.branches.map((b) => b.name)).toEqual(["main"]);
  });
});

describe("resolveSwitchTarget", () => {
  it("keeps local branches as-is, even ones starting with origin/", () => {
    expect(resolveSwitchTarget(["main", "origin/x"], "origin/x")).toBe("origin/x");
    expect(resolveSwitchTarget(["main"], "proto/a")).toBe("proto/a");
  });

  it("strips one origin/ prefix for remote-only entries", () => {
    expect(resolveSwitchTarget(["main"], "origin/proto/beta")).toBe("proto/beta");
    expect(resolveSwitchTarget([], "origin/main")).toBe("main");
  });

  it("leaves non-origin names untouched", () => {
    expect(resolveSwitchTarget(["main"], "nope")).toBe("nope");
  });
});

describe("local branch ops", () => {
  it("lists local branches with the current branch marked", async () => {
    const { snap, files } = await localRepo();
    // listBranches fetch-touches the network; offline it falls back to local
    // state, which is exactly what this asserts.
    const r = await listBranches({ token: "", files, snapshot: snap, meta: META, identity: IDENTITY });
    const names = r.branches.map((b) => b.name);
    expect(names).toContain("main");
    expect(names).toContain("proto/alpha");
    expect(r.current).toBe("main");
    expect(r.branches.find((b) => b.name === "main")?.current).toBe(true);
  });

  it("keeps a local branch named remotes/* local", async () => {
    const fs = new MemoryFileSystem();
    const git = createGit({ fs, cwd: "/repo", identity: { ...IDENTITY, locked: true } });
    await git.exec("init");
    await fs.writeFile(`${WORKTREE}/a.txt`, "x\n");
    await git.exec("add -A");
    await git.exec("commit -m init");
    await git.exec("checkout -b remotes/foo");
    await git.exec("checkout main");
    const snap = await snapshotGitDir(fs);
    const r = await listBranches({
      token: "",
      files: { "a.txt": "x\n" },
      snapshot: snap,
      meta: META,
      identity: IDENTITY,
    });
    expect(r.branches.find((b) => b.name === "remotes/foo")).toMatchObject({ remote: false });
  });

  it("requires a linked repo and stored history", async () => {
    const { snap, files } = await localRepo();
    await expect(listBranches({ token: "", files, snapshot: snap, meta: null, identity: IDENTITY })).rejects.toThrow(
      /no linked repo/,
    );
    await expect(
      listBranches({ token: "", files, snapshot: null, meta: META, identity: IDENTITY }),
    ).rejects.toThrow(/no git history/);
  });

  it("switches branches and reports the new worktree", async () => {
    const { snap, files } = await localRepo();
    const r = await switchBranch({
      token: "",
      files,
      snapshot: snap,
      meta: META,
      name: "proto/alpha",
      identity: IDENTITY,
    });
    expect(r.branch).toBe("proto/alpha");
    expect(r.files["index.html"]).toBe("alpha\n");
  });

  it("switch rejects unknown and invalid names", async () => {
    const { snap, files } = await localRepo();
    await expect(
      switchBranch({ token: "", files, snapshot: snap, meta: META, name: "nope", identity: IDENTITY }),
    ).rejects.toThrow(/could not switch to nope/);
    await expect(
      switchBranch({ token: "", files, snapshot: snap, meta: META, name: "bad name!", identity: IDENTITY }),
    ).rejects.toThrow(/invalid branch name/);
  });

  it("switch refuses a dirty worktree with a commit-first hint", async () => {
    const { snap } = await localRepo();
    // index.html differs between main and proto/alpha; a dirty edit would be
    // overwritten by the checkout, so git refuses and we say how to proceed.
    await expect(
      switchBranch({
        token: "",
        files: { "index.html": "dirty-uncommitted\n" },
        snapshot: snap,
        meta: META,
        name: "proto/alpha",
        identity: IDENTITY,
      }),
    ).rejects.toThrow(/Commit or stash your changes/);
  });

  it("createBranch validates names before touching the network", async () => {
    const { snap, files } = await localRepo();
    for (const bad of ["", "bad name!", "--force", "-x"]) {
      await expect(
        createBranch({ token: "", files, snapshot: snap, meta: META, name: bad, identity: IDENTITY }),
      ).rejects.toThrow(/branch name|must not start with a dash/);
    }
    await expect(
      createBranch({ token: "", files, snapshot: snap, meta: META, name: "proto/ok", identity: IDENTITY }),
    ).rejects.toThrow(/created locally but the push failed|push failed|fetch failed|HTTP|network|fetch/i);
  });

  it("delete refuses unmerged proto branches with the explicit spelling", async () => {
    // proto/alpha carries a commit main lacks, so `-d` refuses it.
    const { snap, files } = await localRepo();
    await expect(
      deleteBranch({ token: "", files, snapshot: snap, meta: META, name: "proto/alpha", identity: IDENTITY }),
    ).rejects.toThrow(/not fully merged|git branch -D/);
  });

  it("delete of a merged branch removes it locally, then reports the remote failure", async () => {
    const fs = new MemoryFileSystem();
    const git = createGit({ fs, cwd: "/repo", identity: { ...IDENTITY, locked: true } });
    await git.exec("init");
    await fs.writeFile(`${WORKTREE}/a.txt`, "x\n");
    await git.exec("add -A");
    await git.exec("commit -m init");
    // Same commit as main: fully merged, so the local `-d` succeeds and only
    // the origin push (no network here) fails.
    await git.exec("checkout -b proto/gone");
    await git.exec("checkout main");
    const snap = await snapshotGitDir(fs);
    await expect(
      deleteBranch({
        token: "",
        files: { "a.txt": "x\n" },
        snapshot: snap,
        meta: META,
        name: "proto/gone",
        identity: IDENTITY,
      }),
    ).rejects.toThrow(/deleted proto\/gone locally but the remote delete failed/);
  });

  it("delete refuses non-proto branches and the current branch", async () => {
    const { snap, files } = await localRepo();
    await expect(
      deleteBranch({ token: "", files, snapshot: snap, meta: META, name: "main", identity: IDENTITY }),
    ).rejects.toThrow(/only proto/);
    await expect(
      deleteBranch({ token: "", files, snapshot: snap, meta: META, name: "feature/x", identity: IDENTITY }),
    ).rejects.toThrow(/only proto/);
    // Deleting the checked-out branch is refused before any network call.
    const onAlpha = await switchBranch({
      token: "",
      files,
      snapshot: snap,
      meta: META,
      name: "proto/alpha",
      identity: IDENTITY,
    });
    await expect(
      deleteBranch({
        token: "",
        files: onAlpha.files,
        snapshot: onAlpha.snapshot,
        meta: META,
        name: "proto/alpha",
        identity: IDENTITY,
      }),
    ).rejects.toThrow(/current branch/);
  });
});

describe("branch API endpoints", () => {
  function testEnv(opts: { token: string | null; turnActive?: boolean }) {
    const calls: { created: unknown[]; switched: unknown[]; deleted: unknown[]; branched: number } = {
      created: [],
      switched: [],
      deleted: [],
      branched: 0,
    };
    const stub = {
      getGitHubToken: async () => opts.token,
      isTurnActive: async () => opts.turnActive ?? false,
      getBranches: async () => {
        calls.branched++;
        return { current: "main", branches: [{ name: "main", current: true, remote: false }], linked: { owner: "o", repo: "r", branch: "main" } };
      },
      createBranch: async (name: string) => {
        calls.created.push(name);
        return { branch: name, output: "ok", files: {} };
      },
      switchBranch: async (branch: string) => {
        calls.switched.push(branch);
        return { branch, output: "ok", files: {} };
      },
      deleteBranch: async (branch: string) => {
        calls.deleted.push(branch);
        return { branch: "main", output: "ok", files: {} };
      },
      build: async () => ({ ok: true }),
      getGitHubStatus: async () => ({ linked: { owner: "o", repo: "r", branch: "main" } }),
      getFiles: async () => ({}),
    };
    return {
      env: {
        GITHUB_CLIENT_ID: "id",
        GITHUB_CLIENT_SECRET: "secret",
        APP: { idFromName: (n: string) => n, get: () => stub },
      } as unknown as Env,
      stub,
      calls,
    };
  }

  const call = (path: string, env: Env, init?: RequestInit) =>
    worker.fetch(new Request(`https://app.test${path}`, init), env);
  const post = (path: string, env: Env, body: unknown) =>
    call(path, env, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("lists branches without typing and 401s when anonymous", async () => {
    const { env, calls } = testEnv({ token: "gho_t" });
    const res = await call("/api/git/branches", env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { current: string; branches: unknown[] };
    expect(body.current).toBe("main");
    expect(body.branches).toHaveLength(1);
    expect(calls.branched).toBe(1);

    const anon = testEnv({ token: null });
    for (const r of [
      await call("/api/git/branches", anon.env),
      await post("/api/git/branch/new", anon.env, { name: "proto/x" }),
      await post("/api/git/branch/switch", anon.env, { branch: "main" }),
      await post("/api/git/branch/delete", anon.env, { branch: "proto/x" }),
    ]) {
      expect(r.status).toBe(401);
    }
  });

  it("refuses branch mutations mid-turn with 409 like Create/Commit", async () => {
    const { env, calls } = testEnv({ token: "gho_t", turnActive: true });
    for (const r of [
      await post("/api/git/branch/new", env, { name: "proto/x" }),
      await post("/api/git/branch/switch", env, { branch: "main" }),
      await post("/api/git/branch/delete", env, { branch: "proto/x" }),
    ]) {
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toMatch(/agent turn/);
    }
    expect(calls.created).toHaveLength(0);
    expect(calls.switched).toHaveLength(0);
    expect(calls.deleted).toHaveLength(0);
  });

  it("creates, switches, and deletes through the stub flow", async () => {
    const { env, calls } = testEnv({ token: "gho_t" });
    const created = await post("/api/git/branch/new", env, { name: "proto/x" });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { branch: string }).branch).toBe("proto/x");
    const switched = await post("/api/git/branch/switch", env, { branch: "proto/x" });
    expect(switched.status).toBe(200);
    expect(((await switched.json()) as { branch: string }).branch).toBe("proto/x");
    const deleted = await post("/api/git/branch/delete", env, { branch: "proto/x" });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as { branch: string }).branch).toBe("main");
    expect(calls.created).toEqual(["proto/x"]);
    expect(calls.switched).toEqual(["proto/x"]);
    expect(calls.deleted).toEqual(["proto/x"]);
  });

  it("requires a branch name, and a proto/ prefix for creation", async () => {
    const { env } = testEnv({ token: "gho_t" });
    expect((await post("/api/git/branch/new", env, { name: "" })).status).toBe(400);
    expect((await post("/api/git/branch/new", env, { name: "feature/x" })).status).toBe(400);
    expect(
      ((await (await post("/api/git/branch/new", env, { name: "feature/x" })).json()) as { error: string }).error,
    ).toMatch(/proto\//);
    expect((await post("/api/git/branch/switch", env, {})).status).toBe(400);
    expect((await post("/api/git/branch/delete", env, {})).status).toBe(400);
  });

  it("exposes the picker in the served page", async () => {
    const { env } = testEnv({ token: "gho_t" });
    const html = await (await call("/", env)).text();
    for (const needle of [
      "Refresh branches",
      "New branch + push",
      "Delete branch",
      "/api/git/branches",
      "/api/git/branch/new",
      "/api/git/branch/switch",
      "/api/git/branch/delete",
      "proto/",
      "(default branch)",
      "/api/github/branches?ref=",
      "Remote-only branch",
    ]) {
      expect(html, needle).toContain(needle);
    }
  });

  it("settings sub-tabs clear drafts, scope branches, and gate correctly", async () => {
    const { env } = testEnv({ token: "gho_t" });
    const html = await (await call("/", env)).text();
    // Model setup renders before the status-gated early return: the last
    // renderGhModelSetup call site is the !ghStatus branch, immediately
    // ahead of its loading/retry UI.
    const setupAt = html.lastIndexOf("renderGhModelSetup(wrap);");
    const gateAt = html.indexOf("if (ghStatusFailed)");
    expect(setupAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    expect(setupAt).toBeLessThan(gateAt);
    expect(gateAt - setupAt).toBeLessThan(300);
    // Delete-button enablement recomputes inside the input handler itself.
    expect(html).toMatch(/din\.oninput = \(\) => \{[^}]*syncDelBtn\(\)[^}]*\}/);
    // Successful actions consume their drafts only when untouched mid-flight.
    for (const needle of [
      "ghDraft.commitMsg === submitted",
      "ghDraft.createName === submittedName",
      "ghDraft.promoteName === submittedName",
      "ghDraft.newBranch === submitted",
      // branch drafts reset on repo change, not on every cache refresh
      "ghSetLinked(r.linked || null)",
      "ghNoteLinked(prevLink)",
    ]) {
      expect(html, needle).toContain(needle);
    }
  });
});
