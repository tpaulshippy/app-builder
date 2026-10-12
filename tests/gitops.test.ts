import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "just-git";
import {
  gitLog,
  gitStatus,
  readWorkingFiles,
  restoreSnapshot,
  snapshotGitDir,
  writeWorkingFiles,
  WORKTREE,
} from "../src/gitops";

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
    await writeWorkingFiles(fs, { "index.ts": "ok" });
    await fs.writeFile(`${WORKTREE}/../evil.ts`, "nope");
    await fs.writeFile(`${WORKTREE}/bin.dat`, new Uint8Array([104, 105, 0, 1]));
    const { files, skipped } = await readWorkingFiles(fs);
    expect(files["index.ts"]).toBe("ok");
    expect("evil.ts" in files).toBe(false);
    expect("bin.dat" in files).toBe(false);
    expect(skipped.join(",")).toContain("binary");
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
});
