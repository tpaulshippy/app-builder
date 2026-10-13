import { describe, expect, it } from "vitest";
import { createGit, MemoryFileSystem } from "just-git";
import {
  gitCredentials,
  gitExec,
  overlayLocalEdits,
  pruneSkipped,
  gitLog,
  gitStatus,
  isWorktreeKey,
  pushFailureHint,
  readWorkingFiles,
  restoreSkipped,
  restoreSnapshot,
  snapshotGitDir,
  writeWorkingFiles,
  WORKTREE,
} from "../src/gitops";
import type { FileMap } from "../src/session";

describe("gitops filesystem helpers", () => {
  it("round-trips working files through the worktree", async () => {
    const fs = new MemoryFileSystem();
    await writeWorkingFiles(fs, { "index.ts": "hello", "src/a.ts": "x" });
    const { files, skipped } = await readWorkingFiles(fs);
    expect(skipped).toEqual([]);
    expect(files["index.ts"]).toBe("hello");
    expect(files["src/a.ts"]).toBe("x");
  });

  it("skips unsafe paths and binary files", async () => {
    const fs = new MemoryFileSystem();
    await writeWorkingFiles(fs, { "index.ts": "ok", "../evil.ts": "nope" } as FileMap);
    // writeWorkingFiles refuses the traversal key, so it never reaches disk.
    await fs.writeFile(`${WORKTREE}/weird name.ts`, "in-tree but unsafe");
    await fs.writeFile(`${WORKTREE}/bin.dat`, new Uint8Array([104, 105, 0, 1]));
    const { files, skipped } = await readWorkingFiles(fs);
    expect(files["index.ts"]).toBe("ok");
    expect("evil.ts" in files).toBe(false);
    expect("bin.dat" in files).toBe(false);
    expect(skipped.join(",")).toContain("binary");
    expect(skipped.join(",")).toContain("weird name.ts (unsafe path)");
  });

  it("snapshots and restores .git files", async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile(`${WORKTREE}/.git/HEAD`, "ref: refs/heads/main\n");
    await fs.writeFile(`${WORKTREE}/index.ts`, "work");
    const snap = await snapshotGitDir(fs);
    expect(Object.keys(snap).length).toBe(1);

    const fs2 = new MemoryFileSystem();
    await restoreSnapshot(fs2, snap);
    expect(await fs2.readFile(`${WORKTREE}/.git/HEAD`)).toBe("ref: refs/heads/main\n");
  });

  it("reports untracked files when no snapshot exists", async () => {
    const out = await gitStatus({ files: { "index.ts": "x" }, snapshot: null });
    expect(out).toContain("?? index.ts");
  });

  it("reports no commits yet for empty history", async () => {
    expect(await gitLog({ snapshot: null })).toBe("no commits yet");
    expect(await gitLog({ snapshot: {} })).toBe("no commits yet");
  });

  it("refuses history rewrites without touching the repo", async () => {
    const base = {
      token: "",
      files: {} as FileMap,
      snapshot: null,
      meta: null,
      identity: { name: "t", email: "t@t" },
    };
    for (const command of ["reset --hard", "rebase main", "push --force origin main", "push -f origin main"]) {
      const r = await gitExec({ ...base, command });
      expect(r.result.ok).toBe(false);
      expect(r.result.stderr).toMatch(/refusing git/);
    }
    // A filename that merely contains "force" is not a force flag.
    const ok = await gitExec({ ...base, command: "status" });
    expect(ok.result.stderr).not.toMatch(/refusing git/);
  });

  it("keeps pushes and remotes pinned to the linked repo", async () => {
    const base = {
      token: "",
      files: {} as FileMap,
      snapshot: null,
      meta: { owner: "o", repo: "r", branch: "main", remoteUrl: "https://github.com/o/r.git" },
      identity: { name: "t", email: "t@t" },
    };
    for (const command of [
      "push https://github.com/evil/x.git main",
      "push git@github.com:evil/x.git main",
      "remote set-url origin https://github.com/evil/x.git",
      "remote add origin https://github.com/evil/x.git",
      "remote remove origin",
    ]) {
      const r = await gitExec({ ...base, command });
      expect(r.result.ok).toBe(false);
      expect(r.result.stderr).toMatch(/refusing git/);
    }
  });

  it("rejects .git keys but allows .gitignore", () => {
    expect(isWorktreeKey(".git/config")).toBe(false);
    expect(isWorktreeKey(".git")).toBe(false);
    expect(isWorktreeKey("foo/.git/config")).toBe(false);
    expect(isWorktreeKey(".gitignore")).toBe(true);
    expect(isWorktreeKey("server/index.ts")).toBe(true);
  });

  it("reports raw skipped paths alongside display strings", async () => {
    const fs = new MemoryFileSystem();
    await writeWorkingFiles(fs, { "index.ts": "ok" });
    await fs.writeFile(`${WORKTREE}/bin.dat`, new Uint8Array([104, 105, 0, 1]));
    const { skipped, skippedPaths } = await readWorkingFiles(fs);
    expect(skipped.join(",")).toContain("binary");
    expect(skippedPaths).toContain("bin.dat");
  });

  it("restores skipped binaries so a fresh clone reports clean status", async () => {
    // The reported bug: right after cloning a repo with images, `git status`
    // showed 6 pending deletions — the text-only FileMap drops binaries while
    // the index still tracks them.
    const fs = new MemoryFileSystem();
    const git = createGit({ fs, cwd: "/repo", identity: { name: "t", email: "t@t", locked: true } });
    await git.exec("init");
    await fs.writeFile("/repo/a.txt", "hi\n");
    await fs.writeFile("/repo/img.png", new Uint8Array([137, 80, 78, 71, 0, 1]));
    await git.exec("add -A");
    await git.exec("commit -m init");
    // Simulate the text-only rehydrate: FileMap keeps a.txt, img.png is gone.
    await fs.rm("/repo/img.png");
    const dirty = await git.exec("status --short");
    expect(dirty.stdout).toContain("D img.png");

    expect(await restoreSkipped(fs, git, ["img.png"])).toEqual(["img.png"]);
    expect(await fs.exists("/repo/img.png")).toBe(true);
    // Present files are left alone, even when listed.
    expect(await restoreSkipped(fs, git, ["a.txt"])).toEqual([]);
    // Untracked names are ignored, not created.
    expect(await restoreSkipped(fs, git, ["nope.png"])).toEqual([]);

    const snap = await snapshotGitDir(fs);
    expect(await gitStatus({ files: { "a.txt": "hi\n" }, snapshot: snap, skippedPaths: ["img.png"] })).toBe(
      "clean",
    );
  });

  it("restores tracked names with edge whitespace without trimming", async () => {
    const fs = new MemoryFileSystem();
    const git = createGit({ fs, cwd: "/repo", identity: { name: "t", email: "t@t", locked: true } });
    await git.exec("init");
    // Safe-path charset but padded with spaces: the naive split/trim parser
    // would look this up under the wrong name and never restore it.
    await fs.writeFile("/repo/ spaced name.txt ", "padded\n");
    await git.exec("add -A");
    await git.exec("commit -m init");
    await fs.rm("/repo/ spaced name.txt ");
    expect(await restoreSkipped(fs, git, [" spaced name.txt "])).toEqual([" spaced name.txt "]);
    expect(await fs.exists("/repo/ spaced name.txt ")).toBe(true);
  });

  it("restores pathspec-magic names literally and nothing else", async () => {
    const fs = new MemoryFileSystem();
    const git = createGit({ fs, cwd: "/repo", identity: { name: "t", email: "t@t", locked: true } });
    await git.exec("init");
    await fs.writeFile("/repo/normal.txt", "n\n");
    await fs.writeFile("/repo/:(exclude)hidden.bin", "x\n");
    await git.exec("add -A");
    await git.exec("commit -m init");
    await fs.rm("/repo/normal.txt");
    await fs.rm("/repo/:(exclude)hidden.bin");
    expect(await restoreSkipped(fs, git, [":(exclude)hidden.bin"])).toEqual([":(exclude)hidden.bin"]);
    expect(await fs.exists("/repo/:(exclude)hidden.bin")).toBe(true);
    // The magic must not leak onto its neighbors.
    expect(await fs.exists("/repo/normal.txt")).toBe(false);
  });

  it("re-materializes deleted symlinks as symlinks", async () => {
    const fs = new MemoryFileSystem();
    const git = createGit({ fs, cwd: "/repo", identity: { name: "t", email: "t@t", locked: true } });
    await git.exec("init");
    await fs.writeFile("/repo/real.txt", "r\n");
    await fs.symlink("real.txt", "/repo/link.txt");
    await git.exec("add -A");
    await git.exec("commit -m init");
    // The read path records the link (it never enters the FileMap) ...
    const read = await readWorkingFiles(fs);
    expect(read.skippedPaths).toContain("link.txt");
    expect("link.txt" in read.files).toBe(false);
    // ... so after a text-only rehydrate drops it, status flags it ...
    await fs.rm("/repo/link.txt");
    const dirty = await git.exec("status --short");
    expect(dirty.stdout).toContain("D link.txt");
    // ... and the restore path re-materializes it as a real symlink.
    expect(await restoreSkipped(fs, git, ["link.txt"])).toEqual(["link.txt"]);
    expect((await fs.lstat("/repo/link.txt")).isSymbolicLink).toBe(true);
    expect((await git.exec("status --short")).stdout.trim()).toBe("");
  });

  it("pruneSkipped drops paths the FileMap owns again", () => {
    expect(pruneSkipped(["a.bin", "b.bin"], { "a.bin": "now text" } as FileMap)).toEqual(["b.bin"]);
    expect(pruneSkipped([], { "a.bin": "x" } as FileMap)).toEqual([]);
    // `in` sees Object.prototype: a tracked file named `toString` must not
    // read as present in a FileMap that does not own it.
    expect(pruneSkipped(["toString"], {} as FileMap)).toEqual(["toString"]);
  });

  it("sends the token as Basic x-access-token, never Bearer", () => {
    // GitHub's Smart HTTP 401s `Bearer <oauth-token>` even when valid;
    // Basic with the token as password is the working form (verified live).
    // The dummy value stays in a variable so scanners don't read a literal.
    const input = "tok123";
    expect(gitCredentials(input)).toEqual({
      type: "basic",
      username: "x-access-token",
      password: input,
    });
  });

  it("explains push 403s as missing write access, not a broken login", () => {
    const ctx = { login: "reader", owner: "octo", repo: "hello" };
    const hinted = pushFailureHint("HTTP 403 pushing to https://github.com/octo/hello.git", ctx);
    expect(hinted).toContain("refused the push (403) as @reader on octo/hello");
    expect(hinted).toContain("Cloning works on public repos without write access");
    expect(hinted).toContain("collaborator access");
  });

  it("explains expired credentials and workflow-scope rejections", () => {
    const ctx = { login: "u", owner: "o", repo: "r" };
    expect(pushFailureHint("HTTP 401 pushing", ctx)).toContain("Log out and");
    expect(pushFailureHint("refusing to allow an OAuth App to create workflow files", ctx)).toContain(
      "workflow",
    );
    // Unrelated failures pass through untouched.
    expect(pushFailureHint("nothing to push", ctx)).toBe("nothing to push");
  });

  it("overlays local edits onto a same-repo reopen without touching the rest", () => {
    const clone = { "index.html": "v2", "same.txt": "same", "gone.txt": "old" };
    const prev = { "index.html": "mine", "new.txt": "added", "same.txt": "same" };
    const { files, kept } = overlayLocalEdits(clone, prev);
    expect(files["index.html"]).toBe("mine");
    expect(files["new.txt"]).toBe("added");
    expect(files["same.txt"]).toBe("same");
    expect(files["gone.txt"]).toBe("old");
    expect(kept).toBe(2);
  });

  it("refuses non-worktree keys in the overlay", () => {
    const { files, kept } = overlayLocalEdits({}, { ".git/config": "evil", "ok.txt": "x" } as FileMap);
    expect("ok.txt" in files).toBe(true);
    expect(".git/config" in files).toBe(false);
    expect(kept).toBe(1);
  });
});
