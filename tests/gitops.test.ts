import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "just-git";
import {
  gitExec,
  gitLog,
  gitStatus,
  readWorkingFiles,
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
});
