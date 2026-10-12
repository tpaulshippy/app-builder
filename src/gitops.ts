/**
 * Git operations backed by just-git (pure TypeScript, Workers-safe).
 *
 * The Durable Object owns the working tree as a `FileMap` (path -> text) and
 * the git database as a snapshot of `/repo/.git` file bytes. Each operation
 * rehydrates a fresh in-memory filesystem from those two, runs just-git
 * commands against github.com over Smart HTTP, then snapshots `.git` back and
 * extracts the working tree into a new `FileMap`.
 *
 * Text-only working tree: `FileMap` values are strings, so binary files are
 * skipped on extraction and reported. They stay in the object store (commits
 * still round-trip them) but are not editable here — which is exactly the
 * "not previewable but still editable + git-able" case from the request.
 */

import { createGit, MemoryFileSystem } from "just-git";
import type { FileSystem } from "just-git";
import { hasGitSegment, isSafePath } from "./paths";
import type { FileMap } from "./session";

export const WORKTREE = "/repo";
export const GIT_DIR_NAME = ".git";

export type GitMeta = {
  owner: string;
  repo: string;
  branch: string;
  remoteUrl: string;
};

export type GitSnapshot = Record<string, { kind: "file"; b64: string } | { kind: "symlink"; target: string }>;

export type GitResult = { ok: boolean; stdout: string; stderr: string };

const MAX_TEXT_BYTES = 1_000_000;
const MAX_FILES = 2000;

function u8ToB64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64ToU8(b64: string): Uint8Array {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

type Identity = { name: string; email: string };

export function identityFor(login: string): Identity {
  const name = login || "app-builder";
  return { name, email: `${name}@users.noreply.github.com` };
}

/**
 * Smart HTTP credentials for github.com.
 *
 * Must be Basic (`x-access-token` + token), not Bearer: GitHub's git
 * endpoints answer `401` to `Bearer <oauth-token>` even when the token is
 * valid (verified live: Bearer 401 vs Basic 200 on the same repo/token).
 * Exported for tests; `gitFor` is the only caller.
 */
export function gitCredentials(token: string): { type: "basic"; username: string; password: string } {
  return { type: "basic", username: "x-access-token", password: token };
}

function gitFor(fs: FileSystem, cwd: string, token: string, identity: Identity) {
  return createGit({
    fs,
    cwd,
    identity: { ...identity, locked: true },
    credentials: () => gitCredentials(token),
    network: { allowed: ["github.com"] },
  });
}

async function exec(git: { exec: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }> }, cmd: string): Promise<GitResult> {
  const r = await git.exec(cmd);
  return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr };
}

async function lstatFs(fs: FileSystem, p: string) {
  if (fs.lstat) return fs.lstat(p);
  return fs.stat(p);
}

async function walkFiles(fs: FileSystem, dir: string, out: string[] = []): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = dir === "/" ? `/${n}` : `${dir}/${n}`;
    let st;
    try {
      st = await lstatFs(fs, p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink) {
      out.push(p);
    } else if (st.isDirectory) {
      await walkFiles(fs, p, out);
    } else if (st.isFile) {
      out.push(p);
    }
  }
  return out;
}

function toWorktreeKey(abs: string): string | null {
  const prefix = `${WORKTREE}/`;
  if (!abs.startsWith(prefix)) return null;
  const rel = abs.slice(prefix.length);
  if (!rel || rel === GIT_DIR_NAME || rel.startsWith(`${GIT_DIR_NAME}/`)) return null;
  if (!isSafePath(rel) || hasGitSegment(rel)) return null;
  return rel;
}

/**
 * FileMap keys that may be materialized into the worktree. `.gitignore` is
 * legitimate, but anything inside `.git/` would be written back into the git
 * database by `writeWorkingFiles` (and staged by `commitAndPush`, which git
 * then refuses) — so it is never a valid worktree key.
 */
export function isWorktreeKey(key: string): boolean {
  // Any `.git` segment is refused, not just a top-level one: `foo/.git/x`
  // would otherwise materialize a nested gitdir into the worktree.
  return isSafePath(key) && !hasGitSegment(key);
}

/** Snapshot every file under /repo/.git so the DO can persist the git database. */
export async function snapshotGitDir(fs: FileSystem): Promise<GitSnapshot> {
  const snap: GitSnapshot = {};
  const all = await walkFiles(fs, `${WORKTREE}/${GIT_DIR_NAME}`);
  for (const p of all) {
    const st = await lstatFs(fs, p);
    if (st.isSymbolicLink) {
      if (!fs.readlink) continue;
      snap[p] = { kind: "symlink", target: await fs.readlink(p) };
    } else if (st.isFile) {
      const buf = await fs.readFileBuffer(p);
      snap[p] = { kind: "file", b64: u8ToB64(buf) };
    }
  }
  return snap;
}

export async function restoreSnapshot(fs: FileSystem, snap: GitSnapshot): Promise<void> {
  for (const [p, e] of Object.entries(snap)) {
    if (e.kind === "symlink") {
      if (!fs.symlink) continue;
      try {
        await fs.symlink(e.target, p);
      } catch {
        /* exists from a previous restore */
      }
    } else {
      await fs.writeFile(p, b64ToU8(e.b64));
    }
  }
}

export async function writeWorkingFiles(fs: FileSystem, files: FileMap): Promise<void> {
  for (const [key, content] of Object.entries(files)) {
    if (!isWorktreeKey(key)) continue;
    await fs.writeFile(`${WORKTREE}/${key}`, content);
  }
}

/**
 * Read the worktree back into a FileMap. Binary files (NUL byte), oversized
 * files, and unsafe paths are skipped and reported rather than corrupting
 * the text-only FileMap.
 */
export async function readWorkingFiles(
  fs: FileSystem,
): Promise<{ files: FileMap; skipped: string[] }> {
  const files: FileMap = {};
  const skipped: string[] = [];
  const all = await walkFiles(fs, WORKTREE);
  let count = 0;
  for (const p of all) {
    const key = toWorktreeKey(p);
    if (key === null) {
      // .git internals are expected; anything else outside the safe worktree
      // namespace is worth telling the user about, not dropping silently.
      const prefix = `${WORKTREE}/`;
      if (p.startsWith(prefix)) {
        const rel = p.slice(prefix.length);
        if (rel && rel !== GIT_DIR_NAME && !rel.startsWith(`${GIT_DIR_NAME}/`)) {
          skipped.push(`${rel} (unsafe path)`);
        }
      }
      continue;
    }
    if (count >= MAX_FILES) {
      skipped.push(`${key} (file limit)`);
      continue;
    }
    let st;
    try {
      st = await lstatFs(fs, p);
    } catch {
      continue;
    }
    if (!st.isFile) continue;
    if (st.size > MAX_TEXT_BYTES) {
      skipped.push(`${key} (too large)`);
      continue;
    }
    let buf: Uint8Array;
    try {
      buf = await fs.readFileBuffer(p);
    } catch {
      skipped.push(`${key} (unreadable)`);
      continue;
    }
    if (buf.includes(0)) {
      skipped.push(`${key} (binary)`);
      continue;
    }
    try {
      files[key] = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      count++;
    } catch {
      skipped.push(`${key} (binary)`);
    }
  }
  return { files, skipped };
}

function freshFs(): MemoryFileSystem {
  return new MemoryFileSystem();
}

/** Clone owner/repo into a fresh worktree. */
export async function cloneRepo(opts: {
  token: string;
  owner: string;
  repo: string;
  branch?: string;
  identity: Identity;
}): Promise<{ files: FileMap; snapshot: GitSnapshot; meta: GitMeta; skipped: string[]; output: string }> {
  const fs = freshFs();
  const git = gitFor(fs, "/", opts.token, opts.identity);
  const url = `https://github.com/${opts.owner}/${opts.repo}.git`;
  const branchFlag = opts.branch ? `-b ${quote(opts.branch)} ` : "";
  const r = await exec(git as never, `clone ${branchFlag}${url} ${WORKTREE}`);
  if (!r.ok) throw new Error(`clone failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  const { files, skipped } = await readWorkingFiles(fs);
  const snapshot = await snapshotGitDir(fs);
  const branch = opts.branch ?? (await currentBranch(fs, opts.token, opts.identity)) ?? "main";
  return {
    files,
    snapshot,
    skipped,
    meta: { owner: opts.owner, repo: opts.repo, branch, remoteUrl: url },
    output: r.stdout,
  };
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function currentBranch(fs: FileSystem, token: string, identity: Identity): Promise<string | null> {
  try {
    const git = gitFor(fs, WORKTREE, token, identity);
    const r = await exec(git as never, "branch --show-current");
    const b = r.stdout.trim();
    return b || null;
  } catch {
    return null;
  }
}

/** Init a repo from local files and push it to an (empty) GitHub remote. */
export async function initAndPush(opts: {
  token: string;
  files: FileMap;
  remoteUrl: string;
  branch: string;
  message: string;
  identity: Identity;
}): Promise<{ snapshot: GitSnapshot; output: string }> {
  const fs = freshFs();
  const git = gitFor(fs, "/", opts.token, opts.identity);
  const branch = opts.branch || "main";
  let out = "";
  const steps = [
    `init ${WORKTREE}`,
    // createGit cwd is "/", so subsequent commands run with explicit -C
  ];
  for (const s of steps) {
    const r = await exec(git as never, s);
    out += r.stdout + r.stderr;
    if (!r.ok) throw new Error(`git ${s} failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  }
  await writeWorkingFiles(fs, opts.files);
  const work = gitFor(fs, WORKTREE, opts.token, opts.identity);
  const seq = [
    "add -A",
    `commit -m ${quote(opts.message || "initial commit")}`,
    "branch -M main",
    `remote add origin ${opts.remoteUrl}`,
  ];
  // Honor a non-main default branch when asked.
  const rename = branch !== "main" ? [`branch -M ${quote(branch)}`] : [];
  for (const cmd of [...seq.slice(0, 3), ...rename, ...seq.slice(3)]) {
    const r = await exec(work as never, cmd);
    out += r.stdout + r.stderr;
    if (!r.ok) throw new Error(`git ${cmd} failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  }
  const push = await exec(work as never, `push -u origin ${quote(branch)}`);
  out += push.stdout + push.stderr;
  if (!push.ok) throw new Error(`push failed: ${(push.stderr || push.stdout).slice(0, 800)}`);
  return { snapshot: await snapshotGitDir(fs), output: out };
}

/** Commit the current FileMap on top of the persisted history and push. */
export async function commitAndPush(opts: {
  token: string;
  files: FileMap;
  snapshot: GitSnapshot;
  meta: GitMeta;
  message: string;
  identity: Identity;
}): Promise<{ snapshot: GitSnapshot; output: string }> {
  const fs = freshFs();
  await writeWorkingFiles(fs, opts.files);
  await restoreSnapshot(fs, opts.snapshot);
  const git = gitFor(fs, WORKTREE, opts.token, opts.identity);
  let out = "";
  // Stage exactly the text files this session owns — never `add -A`. The
  // FileMap is text-only, so a blanket add would stage tracked binary and
  // oversized blobs (absent from the rehydrated worktree) as deletions and a
  // later push would silently drop them. Deletions go through `git rm` in the
  // panel instead, which updates the index directly.
  const keys = Object.keys(opts.files).filter((k) => isWorktreeKey(k)).sort();
  if (keys.length) {
    const add = await exec(git as never, `add -- ${keys.map(quote).join(" ")}`);
    out += add.stdout + add.stderr;
    if (!add.ok) throw new Error(`git add failed: ${(add.stderr || add.stdout).slice(0, 500)}`);
  }
  const commit = await exec(git as never, `commit -m ${quote(opts.message || "update")}`);
  out += commit.stdout + commit.stderr;
  // "nothing to commit" still pushes (a no-op) rather than erroring the flow.
  if (!commit.ok && !/nothing to commit|no changes/i.test(commit.stdout + commit.stderr)) {
    throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).slice(0, 500)}`);
  }
  const push = await exec(git as never, `push origin ${quote(opts.meta.branch)}`);
  out += push.stdout + push.stderr;
  if (!push.ok) throw new Error(`push failed: ${(push.stderr || push.stdout).slice(0, 800)}`);
  return { snapshot: await snapshotGitDir(fs), output: out };
}

/**
 * Pull remote changes into the worktree; returns the merged FileMap.
 *
 * On conflict the pull fails but the worktree holds conflict-marked text, so
 * the (text) files and the `.git` state (MERGE_HEAD etc.) are still returned
 * with `ok: false` — the editor receives the markers it is told to resolve
 * instead of silently staying on the pre-pull FileMap.
 */
export async function pullRepo(opts: {
  token: string;
  files: FileMap;
  snapshot: GitSnapshot;
  meta: GitMeta;
  identity: Identity;
}): Promise<{
  ok: boolean;
  files: FileMap;
  snapshot: GitSnapshot;
  skipped: string[];
  output: string;
}> {
  const fs = freshFs();
  await writeWorkingFiles(fs, opts.files);
  await restoreSnapshot(fs, opts.snapshot);
  const git = gitFor(fs, WORKTREE, opts.token, opts.identity);
  const r = await exec(git as never, "pull");
  const output = r.stdout + r.stderr;
  const { files, skipped } = await readWorkingFiles(fs);
  const snapshot = await snapshotGitDir(fs).catch(() => opts.snapshot);
  if (!r.ok) {
    // A failed pull is not necessarily a merge conflict (auth, network, and
    // remote errors fail here too). Only treat it as a conflict when git says
    // so; otherwise preserve the real error and leave the session untouched.
    if (!/conflict|needs merge|unmerged|not possible to fast-forward/i.test(output)) {
      throw new Error(`pull failed: ${output.slice(0, 800)}`);
    }
    return {
      ok: false,
      files,
      snapshot,
      skipped,
      output: `pull conflicted — resolve the markers in the editor, then commit.\n${output.slice(0, 800)}`,
    };
  }
  return { ok: true, files, skipped, snapshot, output };
}

export async function gitStatus(opts: {
  files: FileMap;
  snapshot: GitSnapshot | null;
}): Promise<string> {
  // No history yet: everything is untracked.
  if (!opts.snapshot || Object.keys(opts.snapshot).length === 0) {
    const names = Object.keys(opts.files).sort();
    return names.length ? names.map((n) => `?? ${n}`).join("\n") : "no files";
  }
  const fs = freshFs();
  await writeWorkingFiles(fs, opts.files);
  await restoreSnapshot(fs, opts.snapshot);
  const git = gitFor(fs, WORKTREE, "no-token", { name: "x", email: "x@x" });
  const r = await exec(git as never, "status --short");
  if (!r.ok) throw new Error(`git status failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return r.stdout.trim() || "clean";
}

export async function gitLog(opts: {
  snapshot: GitSnapshot | null;
  max?: number;
}): Promise<string> {
  if (!opts.snapshot || Object.keys(opts.snapshot).length === 0) return "no commits yet";
  const fs = freshFs();
  await restoreSnapshot(fs, opts.snapshot);
  // Worktree files are irrelevant for log; an empty worktree is fine.
  const git = gitFor(fs, WORKTREE, "no-token", { name: "x", email: "x@x" });
  const n = Math.min(50, Math.max(1, opts.max ?? 20));
  const r = await exec(git as never, `log --oneline -n ${n}`);
  if (!r.ok) throw new Error(`git log failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return r.stdout.trim() || "no commits yet";
}

export async function gitExec(opts: {
  token: string;
  files: FileMap;
  snapshot: GitSnapshot | null;
  meta: GitMeta | null;
  identity: Identity;
  command: string;
}): Promise<{ files: FileMap; snapshot: GitSnapshot | null; branch: string | null; result: GitResult }> {
  const cmd = opts.command.trim().replace(/^git\s+/, "");
  const noResponse = (stderr: string) => ({
    files: opts.files,
    snapshot: opts.snapshot,
    branch: null as string | null,
    result: { ok: false, stdout: "", stderr },
  });
  const sub = cmd.split(/\s+/)[0] ?? "";
  const allowed = new Set([
    "status", "log", "diff", "branch", "show", "stash", "add", "commit",
    "checkout", "switch", "restore", "merge", "fetch",
    "pull", "push", "remote", "rev-parse", "ls-files", "grep", "mv", "rm",
  ]);
  if (!allowed.has(sub)) {
    return noResponse(`refusing git ${sub || "(empty)"}: not in the allowlist`);
  }
  // History rewrites are never allowed through this runner: the tool
  // description promises it, and pushes run with the user's OAuth token.
  // Tokenize on whitespace and match whole flag tokens so a filename like
  // `force.txt` does not trip the guard (and a glued `-fbranch` form is not
  // a real force flag either).
  const flags = new Set(cmd.split(/\s+/).filter((t) => t.startsWith("-")));
  const forced = [...flags].some(
    (f) => f === "-f" || f === "--force" || f.startsWith("--force-with-lease"),
  );
  if (forced) {
    return noResponse(`refusing git ${sub} with a force flag: history rewrites are disabled here`);
  }
  // Pushes and remote rewrites must not escape the linked repo: `push <url>`
  // would send this checkout anywhere the OAuth token can write, and
  // `remote set-url/add` would repoint `origin` for the next push.
  if (sub === "push") {
    const targets = cmd.split(/\s+/).slice(1).filter((t) => !t.startsWith("-"));
    if (targets.some((t) => t.includes("://") || t.includes("@") || /\.git$/i.test(t))) {
      return noResponse("refusing git push to an explicit URL: pushes go to the linked repo only");
    }
  }
  if (sub === "remote") {
    const action = cmd.split(/\s+/)[1] ?? "";
    if (["add", "set-url", "remove", "rm", "rename"].includes(action)) {
      return noResponse(`refusing git remote ${action}: remotes are managed by the GitHub panel`);
    }
  }
  // Mutating remote commands need auth + a linked repo.
  if (["fetch", "pull", "push"].includes(sub) && !opts.meta) {
    return noResponse(`git ${sub} needs a linked GitHub repo (open or create one first)`);
  }
  const fs = freshFs();
  await writeWorkingFiles(fs, opts.files);
  if (opts.snapshot) await restoreSnapshot(fs, opts.snapshot);
  const git = gitFor(fs, WORKTREE, opts.token || "no-token", opts.identity);
  const result = await exec(git as never, cmd);
  // Sync back whatever the command did to the worktree and to .git.
  const { files } = await readWorkingFiles(fs).catch(() => ({ files: opts.files, skipped: [] }));
  let snapshot = opts.snapshot;
  try {
    const next = await snapshotGitDir(fs);
    if (Object.keys(next).length) snapshot = next;
  } catch {
    /* keep previous snapshot */
  }
  return { files, snapshot, branch: await currentBranch(fs, opts.token, opts.identity), result };
}
