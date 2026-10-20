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
): Promise<{ files: FileMap; skipped: string[]; skippedPaths: string[] }> {
  const files: FileMap = {};
  const skipped: string[] = [];
  const skippedPaths: string[] = [];
  const skip = (display: string, path: string) => {
    skipped.push(display);
    skippedPaths.push(path);
  };
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
          skip(`${rel} (unsafe path)`, rel);
        }
      }
      continue;
    }
    if (count >= MAX_FILES) {
      skip(`${key} (file limit)`, key);
      continue;
    }
    let st;
    try {
      st = await lstatFs(fs, p);
    } catch {
      continue;
    }
    if (!st.isFile) {
      // Symlinks never enter the text-only FileMap either: record them so the
      // restore path re-materializes the link instead of reporting ` D <link>`.
      if (st.isSymbolicLink) skip(`${key} (symlink)`, key);
      continue;
    }
    if (st.size > MAX_TEXT_BYTES) {
      skip(`${key} (too large)`, key);
      continue;
    }
    let buf: Uint8Array;
    try {
      buf = await fs.readFileBuffer(p);
    } catch {
      skip(`${key} (unreadable)`, key);
      continue;
    }
    if (buf.includes(0)) {
      skip(`${key} (binary)`, key);
      continue;
    }
    try {
      files[key] = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      count++;
    } catch {
      skip(`${key} (binary)`, key);
    }
  }
  return { files, skipped, skippedPaths };
}

/**
 * Re-materialize files the text-only FileMap cannot hold (binary, oversized,
 * unsafe-path) from the git object store.
 *
 * Every op rebuilds the worktree from the FileMap, so without this the index
 * still tracks those blobs while the worktree lacks them — and `status`
 * reports phantom deletions on a freshly cloned repo. Only paths that are
 * tracked AND missing are restored, so user deletions (via `git rm`, which
 * updates the index too) are never resurrected. Failures are skipped, not
 * thrown: a path deleted upstream simply is not tracked anymore.
 */
export async function restoreSkipped(
  fs: FileSystem,
  git: { exec: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }> },
  paths: string[],
): Promise<string[]> {
  const uniq = [...new Set(paths)].filter((p) => p && !p.startsWith("/"));
  if (!uniq.length) return [];
  // NUL-terminated: valid pathnames can contain leading/trailing whitespace
  // (which must not be trimmed) and git C-quote unusual names (which must be
  // decoded, not matched literally) — plain `ls-files` breaks both.
  const ls = await exec(git, "ls-files -z");
  if (!ls.ok) return [];
  const tracked = new Set(ls.stdout.split("\0").map((s) => s.replace(/\n$/, "")).filter((s) => s !== ""));
  const restored: string[] = [];
  for (const rel of uniq) {
    if (!tracked.has(rel)) continue;
    if (await fs.exists(`${WORKTREE}/${rel}`)) continue;
    // `:(literal)`: git parses pathspec magic even inside shell quotes, so a
    // tracked name like `:(exclude)hidden.bin` would otherwise match nothing
    // (or the wrong files) instead of the file itself. Verified against the
    // engine: plain quoting errors, the literal prefix restores exactly it.
    const r = await exec(git, `restore -- ${quote(`:(literal)${rel}`)}`);
    if (r.ok) restored.push(rel);
  }
  return restored;
}

/**
 * Overlay pre-existing local files onto a fresh same-repo clone (re-login +
 * reopen). Local edits win and land as uncommitted changes instead of being
 * wiped; every other path stays exactly as cloned. Keys that may not enter
 * the worktree (`.git/*`) are never carried over.
 */
export function overlayLocalEdits(
  cloneFiles: FileMap,
  prevFiles: FileMap,
): { files: FileMap; kept: number } {
  const files: FileMap = { ...cloneFiles };
  let kept = 0;
  for (const [key, content] of Object.entries(prevFiles)) {
    if (!isWorktreeKey(key)) continue;
    if (files[key] !== content) {
      files[key] = content;
      kept++;
    }
  }
  return { files, kept };
}

/**
 * Drop skipped entries that are currently representable in the FileMap.
 *
 * A path that re-enters the FileMap (e.g. a once-binary file replaced with
 * text in the editor) is owned by the FileMap again: keeping it on the
 * restore list would resurrect it if it is later removed, hiding a real
 * deletion. Callers apply this before persisting the list.
 */
export function pruneSkipped(paths: string[], files: FileMap): string[] {
  if (!paths.length) return paths;
  // Own-property check: `in` sees Object.prototype, so a tracked file named
  // `toString` would read as present in an empty FileMap and get pruned.
  return [...new Set(paths)].filter((p) => !Object.prototype.hasOwnProperty.call(files, p));
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
}): Promise<{ files: FileMap; snapshot: GitSnapshot; meta: GitMeta; skipped: string[]; skippedPaths: string[]; output: string }> {
  const fs = freshFs();
  const git = gitFor(fs, "/", opts.token, opts.identity);
  const url = `https://github.com/${opts.owner}/${opts.repo}.git`;
  const branchFlag = opts.branch ? `-b ${quote(opts.branch)} ` : "";
  const r = await exec(git as never, `clone ${branchFlag}${url} ${WORKTREE}`);
  if (!r.ok) throw new Error(`clone failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  const { files, skipped, skippedPaths } = await readWorkingFiles(fs);
  const snapshot = await snapshotGitDir(fs);
  const branch = opts.branch ?? (await currentBranch(fs, opts.token, opts.identity)) ?? "main";
  return {
    files,
    snapshot,
    skipped,
    skippedPaths,
    meta: { owner: opts.owner, repo: opts.repo, branch, remoteUrl: url },
    output: r.stdout,
  };
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Best-effort owner/repo from an https remote url for error messages. */
function repoFromUrl(remoteUrl: string): { owner: string; repo: string } | null {
  const m = remoteUrl.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/i);
  if (!m?.[1] || !m?.[2]) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * Translate a raw git push/fetch/pull failure into something the user (or
 * the agent relaying it) can act on. Clone reads public repos without write
 * access, so a 403 at push time is usually permissions, not a broken login —
 * say which, and how to fix it.
 */
export function pushFailureHint(
  raw: string,
  ctx: { login: string; owner: string; repo: string },
): string {
  const lower = raw.toLowerCase();
  const where = `${ctx.owner}/${ctx.repo}`;
  if (/workflow/.test(lower)) {
    return (
      `${raw}\n` +
      `GitHub refused a workflow-file change as @${ctx.login} on ${where}: pushing ` +
      `.github/workflows/* needs the \`workflow\` OAuth scope. Log out and back in ` +
      `on the GitHub tab to grant it (logins before the scope fix only granted \`repo\`), then retry.`
    );
  }
  if (/401|unauthorized|bad credentials|token.*(expired|revoked|invalid)/.test(lower)) {
    return (
      `${raw}\n` +
      `GitHub rejected the stored credential for ${where} as @${ctx.login}: Log out and ` +
      `back in on the GitHub tab to refresh the token, then retry.`
    );
  }
  if (/403|forbidden|permission|not accessible|resource not accessible|http 403/.test(lower)) {
    return (
      `${raw}\n` +
      `GitHub refused the push (403) as @${ctx.login} on ${where}. Cloning works on public ` +
      `repos without write access — pushing needs it: ask the owner for collaborator access, ` +
      `open a fork instead, or log in as a user with write access. If you can push in a ` +
      `browser, Log out and back in on the GitHub tab to refresh the token (older logins ` +
      `granted only \`repo\` scope), then retry.`
    );
  }
  return raw;
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
  if (!push.ok) {
    const detail = (push.stderr || push.stdout).slice(0, 800);
    const ref = repoFromUrl(opts.remoteUrl);
    throw new Error(
      `push failed: ${ref ? pushFailureHint(detail, { login: opts.identity.name, owner: ref.owner, repo: ref.repo }) : detail}`,
    );
  }
  return { snapshot: await snapshotGitDir(fs), output: out };
}

/**
 * Validate a branch name for the promote path. The value is always shell-
 * quoted before reaching just-git, but a leading `-` would still parse as a
 * flag and control characters/newlines have no business in a branch name —
 * refuse those rather than quoting around them. `HEAD` and bare `@` are
 * rejected too: the fork renames the checkout to the destination branch
 * after pushing, so the name must be valid as a *local* branch, not just as
 * a remote ref — otherwise a push could populate the new repo before the
 * rename throws.
 */
export function assertPromoteBranch(branch: string): void {
  if (!branch || !branch.trim() || /[\s~^:?*[\]\\@{]/.test(branch) || branch.startsWith("-")) {
    throw new Error(`invalid branch name: ${JSON.stringify(branch)}`);
  }
  if (
    branch === "HEAD" ||
    branch === "@" ||
    branch.startsWith("/") ||
    branch.startsWith(".") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock")
  ) {
    throw new Error(`invalid branch name: ${JSON.stringify(branch)}`);
  }
}

/** Validate a `https://github.com/owner/repo.git` remote for the promote path. */
export function assertGitHubRemoteUrl(url: string): { owner: string; repo: string } {
  const ref = repoFromUrl(url);
  if (!ref || url !== `https://github.com/${ref.owner}/${ref.repo}.git`) {
    throw new Error(`refusing remote outside github.com owner/repo.git: ${JSON.stringify(url)}`);
  }
  return ref;
}

/**
 * History-preserving counterpart to `initAndPush`: clone the source branch,
 * retarget its remote to the (new, empty) destination repo, and push the tip
 * so the destination's default branch carries the full commit log — not one
 * squashed "initial commit".
 *
 * A dedicated op on purpose: `gitExec` refuses `remote add/set-url` and
 * pushes to explicit URLs (see the guards there), so the panel cannot be
 * talked into pushing anywhere. Here both endpoints are constructed from the
 * linked repo + the just-created repo (both validated to
 * `github.com/owner/repo.git`), never taken as raw user input.
 */
export async function forkBranchToRepo(opts: {
  token: string;
  sourceOwner: string;
  sourceRepo: string;
  sourceBranch: string;
  destRemoteUrl: string;
  destBranch: string;
  identity: Identity;
}): Promise<{
  snapshot: GitSnapshot;
  files: FileMap;
  skipped: string[];
  skippedPaths: string[];
  output: string;
}> {
  assertPromoteBranch(opts.sourceBranch);
  assertPromoteBranch(opts.destBranch);
  if (!/^[\w.-]+$/.test(opts.sourceOwner) || !/^[\w.-]+$/.test(opts.sourceRepo)) {
    throw new Error(`invalid source repo: ${JSON.stringify(`${opts.sourceOwner}/${opts.sourceRepo}`)}`);
  }
  const dest = assertGitHubRemoteUrl(opts.destRemoteUrl);
  const sourceUrl = `https://github.com/${opts.sourceOwner}/${opts.sourceRepo}.git`;
  const fs = freshFs();
  const git = gitFor(fs, "/", opts.token, opts.identity);
  let out = "";
  const clone = await exec(
    git as never,
    `clone -b ${quote(opts.sourceBranch)} ${quote(sourceUrl)} ${WORKTREE}`,
  );
  out += clone.stdout + clone.stderr;
  if (!clone.ok) {
    throw new Error(`clone of ${opts.sourceOwner}/${opts.sourceRepo}@${opts.sourceBranch} failed: ${(clone.stderr || clone.stdout).slice(0, 500)}`);
  }
  const work = gitFor(fs, WORKTREE, opts.token, opts.identity);
  // Retarget the fresh clone at the new empty repo. `remote remove/add` here
  // is safe by construction (both URLs validated above); the interactive
  // `git remote` runner stays locked down.
  for (const cmd of ["remote remove origin", `remote add origin ${opts.destRemoteUrl}`]) {
    const r = await exec(work as never, cmd);
    out += r.stdout + r.stderr;
    if (!r.ok) throw new Error(`git ${cmd} failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  }
  // Push the tip onto the destination default branch as a refspec: every
  // commit reachable from the source branch lands there, preserving the log.
  // `HEAD:` works when the source branch name (e.g. `proto/foo`) differs
  // from the destination default (`main`).
  const push = await exec(work as never, `push -u origin ${quote(`HEAD:${opts.destBranch}`)}`);
  out += push.stdout + push.stderr;
  if (!push.ok) {
    const detail = (push.stderr || push.stdout).slice(0, 800);
    throw new Error(
      `push failed: ${pushFailureHint(detail, { login: opts.identity.name, owner: dest.owner, repo: dest.repo })}`,
    );
  }
  // Rename the checkout to the destination branch before snapshotting. The
  // relinked session later runs `push origin <meta.branch>` against this
  // snapshot: without the rename the local branch is still `sourceBranch`
  // while the link says `destBranch`, and the first follow-up commit would
  // fail with "src refspec does not match". A no-op when both names match.
  const rename = await exec(work as never, `branch -M ${quote(opts.destBranch)}`);
  out += rename.stdout + rename.stderr;
  if (!rename.ok) throw new Error(`git branch -M failed: ${(rename.stderr || rename.stdout).slice(0, 300)}`);
  const { files, skipped, skippedPaths } = await readWorkingFiles(fs);
  return { snapshot: await snapshotGitDir(fs), files, skipped, skippedPaths, output: out };
}

/** Commit the current FileMap on top of the persisted history and push. */
export async function commitAndPush(opts: {
  token: string;
  files: FileMap;
  snapshot: GitSnapshot;
  skippedPaths?: string[];
  meta: GitMeta;
  message: string;
  identity: Identity;
}): Promise<{ snapshot: GitSnapshot; output: string }> {
  const fs = freshFs();
  await writeWorkingFiles(fs, opts.files);
  await restoreSnapshot(fs, opts.snapshot);
  const git = gitFor(fs, WORKTREE, opts.token, opts.identity);
  await restoreSkipped(fs, git as never, opts.skippedPaths ?? []);
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
  if (!push.ok) {
    const detail = (push.stderr || push.stdout).slice(0, 800);
    throw new Error(
      `push failed: ${pushFailureHint(detail, { login: opts.identity.name, owner: opts.meta.owner, repo: opts.meta.repo })}`,
    );
  }
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
  skippedPaths?: string[];
  meta: GitMeta;
  identity: Identity;
}): Promise<{
  ok: boolean;
  files: FileMap;
  snapshot: GitSnapshot;
  skipped: string[];
  skippedPaths: string[];
  output: string;
}> {
  const fs = freshFs();
  await writeWorkingFiles(fs, opts.files);
  await restoreSnapshot(fs, opts.snapshot);
  const git = gitFor(fs, WORKTREE, opts.token, opts.identity);
  await restoreSkipped(fs, git as never, opts.skippedPaths ?? []);
  const r = await exec(git as never, "pull");
  const output = r.stdout + r.stderr;
  const { files, skipped, skippedPaths } = await readWorkingFiles(fs);
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
      skippedPaths,
      output: `pull conflicted — resolve the markers in the editor, then commit.\n${output.slice(0, 800)}`,
    };
  }
  return { ok: true, files, skipped, skippedPaths, snapshot, output };
}

export async function gitStatus(opts: {
  files: FileMap;
  snapshot: GitSnapshot | null;
  skippedPaths?: string[];
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
  await restoreSkipped(fs, git as never, opts.skippedPaths ?? []);
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
  skippedPaths?: string[];
  meta: GitMeta | null;
  identity: Identity;
  command: string;
}): Promise<{
  files: FileMap;
  snapshot: GitSnapshot | null;
  skippedPaths: string[];
  branch: string | null;
  result: GitResult;
}> {
  const cmd = opts.command.trim().replace(/^git\s+/, "");
  const noResponse = (stderr: string) => ({
    files: opts.files,
    snapshot: opts.snapshot,
    skippedPaths: opts.skippedPaths ?? [],
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
  await restoreSkipped(fs, git as never, opts.skippedPaths ?? []);
  const result = await exec(git as never, cmd);
  // Remote failures surface as just-git's raw `HTTP 401/403 ...`: the agent
  // relays stderr verbatim, so translate it here into the same actionable
  // hint the commit/push paths throw (clone reads fine without write access).
  if (!result.ok && ["fetch", "pull", "push"].includes(sub) && opts.meta) {
    const raw = (result.stderr || result.stdout).slice(0, 800);
    const hinted = pushFailureHint(raw, {
      login: opts.identity.name,
      owner: opts.meta.owner,
      repo: opts.meta.repo,
    });
    if (hinted !== raw) {
      result.stderr = hinted;
    }
  }
  // Sync back whatever the command did to the worktree and to .git. The
  // skipped list is refreshed too: commands like checkout/switch/merge can
  // change which blobs the FileMap cannot hold, and a stale list would leave
  // the new branch's binaries unrestored (phantom deletions until next pull).
  const { files, skippedPaths } = await readWorkingFiles(fs).catch(() => ({
    files: opts.files,
    skipped: [] as string[],
    skippedPaths: opts.skippedPaths ?? [],
  }));
  let snapshot = opts.snapshot;
  try {
    const next = await snapshotGitDir(fs);
    if (Object.keys(next).length) snapshot = next;
  } catch {
    /* keep previous snapshot */
  }
  return { files, snapshot, skippedPaths, branch: await currentBranch(fs, opts.token, opts.identity), result };
}

/**
 * Branch names accepted for create/switch/delete.
 *
 * git-check-ref-format is far stricter than needed here; this enforces the
 * subset that matters for a `proto/<name>` flow over a shell-quoted just-git
 * command: no traversal, no ref-log syntax, no shell-hostile characters.
 * Returns the trimmed name or throws.
 */
export function validateBranchName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new Error("branch name is required");
  if (name.length > 250) throw new Error(`invalid branch name ${JSON.stringify(raw)}: too long`);
  // A leading dash would reach just-git as an option (`checkout --force`),
  // not a branch name — refuse it before any quoting.
  if (name.startsWith("-")) {
    throw new Error(
      `invalid branch name ${JSON.stringify(name)}: must not start with a dash`,
    );
  }
  if (
    !/^[A-Za-z0-9._/-]+$/.test(name) ||
    name.includes("..") ||
    name.includes("@{") ||
    name.includes("//") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.startsWith(".") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name === "HEAD" ||
    name === "@"
  ) {
    throw new Error(
      `invalid branch name ${JSON.stringify(name)}: use letters, numbers, dot, underscore, dash, slash (e.g. proto/my-prototype)`,
    );
  }
  for (const part of name.split("/")) {
    if (!part || part === "." || part === ".." || part.endsWith(".lock")) {
      throw new Error(
        `invalid branch name ${JSON.stringify(name)}: use letters, numbers, dot, underscore, dash, slash (e.g. proto/my-prototype)`,
      );
    }
  }
  return name;
}

export type BranchInfo = { name: string; current: boolean; remote: boolean };

/**
 * Parse one `git branch` listing (local `branch` or remote `branch -r`).
 * Names are used verbatim — unlike the combined `branch -a` form there is no
 * `remotes/` prefix to strip, so a local branch literally named `remotes/foo`
 * stays local. Detached-HEAD lines (`* (HEAD detached at …)`) and symlinks
 * (`origin/HEAD -> origin/main`) are skipped: neither is a branch.
 */
export function parseBranchLines(
  output: string,
  remote: boolean,
): { current: string | null; branches: BranchInfo[] } {
  let current: string | null = null;
  const branches: BranchInfo[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.includes("->")) continue;
    const isCurrent = line.startsWith("* ");
    const name = (isCurrent ? line.slice(2) : line).trim();
    if (!name || name.startsWith("(")) continue;
    branches.push({ name, current: false, remote });
    if (isCurrent) current = name;
  }
  branches.sort((a, b) => a.name.localeCompare(b.name));
  for (const b of branches) b.current = b.name === current;
  return { current, branches };
}

/**
 * Parse `git branch -a` output into local + remote-tracking entries.
 *
 * Lines look like `* main`, `  dev`, `  remotes/origin/foo`; the
 * `remotes/origin/HEAD -> origin/main` symlink line is skipped.
 */
export function parseBranchList(output: string): { current: string | null; branches: BranchInfo[] } {
  let current: string | null = null;
  const seen = new Map<string, BranchInfo>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.includes("->")) continue;
    const isCurrent = line.startsWith("* ");
    const name = (isCurrent ? line.slice(2) : line).trim();
    if (!name) continue;
    // A detached HEAD (`* (HEAD detached at …)`) is not a branch: never list
    // it, and never report it as current.
    if (name.startsWith("(")) continue;
    if (name.startsWith("remotes/")) {
      // `remotes/origin/foo` -> remote entry `origin/foo`.
      const short = name.slice("remotes/".length);
      if (!short || short === "origin/HEAD") continue;
      if (!seen.has(short)) seen.set(short, { name: short, current: false, remote: true });
      if (isCurrent) current = short;
    } else {
      const prev = seen.get(name);
      if (prev) {
        prev.remote = false;
      } else {
        seen.set(name, { name, current: false, remote: false });
      }
      if (isCurrent) current = name;
    }
  }
  const branches = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const b of branches) b.current = b.name === current;
  return { current, branches };
}

/** Rehydrate helper shared by the branch ops below. */
async function rehydrate(opts: { files: FileMap; snapshot: GitSnapshot | null; skippedPaths?: string[] }) {
  const fs = freshFs();
  await writeWorkingFiles(fs, opts.files);
  if (opts.snapshot) await restoreSnapshot(fs, opts.snapshot);
  // Identity/token are irrelevant until a network command runs; the skipped
  // restore only needs a git handle, so a dummy one is fine here.
  const dummy = gitFor(fs, WORKTREE, "no-token", { name: "x", email: "x@x" });
  await restoreSkipped(fs, dummy as never, opts.skippedPaths ?? []);
  return fs;
}

async function syncBack(
  fs: FileSystem,
  opts: { files: FileMap; snapshot: GitSnapshot | null; skippedPaths?: string[] },
): Promise<{ files: FileMap; snapshot: GitSnapshot | null; skippedPaths: string[] }> {
  const read = await readWorkingFiles(fs).catch(() => ({
    files: opts.files,
    skipped: [] as string[],
    skippedPaths: opts.skippedPaths ?? [],
  }));
  let snapshot = opts.snapshot;
  try {
    const next = await snapshotGitDir(fs);
    if (Object.keys(next).length) snapshot = next;
  } catch {
    /* keep previous snapshot */
  }
  return { files: read.files, snapshot, skippedPaths: read.skippedPaths };
}

/**
 * List local + remote-tracking branches for the linked checkout, plus the
 * current branch. Runs `fetch` first (best-effort) so the remote list is not
 * stale from clone time; a failed fetch still lists local state.
 */
export async function listBranches(opts: {
  token: string;
  files: FileMap;
  snapshot: GitSnapshot | null;
  skippedPaths?: string[];
  meta: GitMeta | null;
  identity: Identity;
}): Promise<{ current: string | null; branches: BranchInfo[]; output: string; snapshot: GitSnapshot | null }> {
  if (!opts.meta) throw new Error("no linked repo: open or create one first");
  if (!opts.snapshot || Object.keys(opts.snapshot).length === 0) {
    throw new Error("no git history stored for this session");
  }
  const fs = await rehydrate(opts);
  const git = gitFor(fs, WORKTREE, opts.token || "no-token", opts.identity);
  // Best-effort: a stale remote list is worse than a slow one, but an offline
  // fetch must not fail the whole listing.
  try {
    await exec(git as never, "fetch origin");
  } catch {
    /* list local state below */
  }
  // Separate listings: `branch -a` cannot tell a local branch named
  // `remotes/foo` apart from the remote-tracking ref `remotes/foo`, so plain
  // `branch` is always local and `branch -r` is always remote.
  const localR = await exec(git as never, "branch");
  if (!localR.ok) throw new Error(`git branch failed: ${(localR.stderr || localR.stdout).slice(0, 300)}`);
  const remoteR = await exec(git as never, "branch -r");
  const local = parseBranchLines(localR.stdout, false);
  const remote = remoteR.ok ? parseBranchLines(remoteR.stdout, true) : { branches: [] as BranchInfo[] };
  const localNames = new Set(local.branches.map((b) => b.name));
  const branches = [...local.branches];
  for (const b of remote.branches) {
    if (!localNames.has(b.name)) branches.push(b);
  }
  branches.sort((a, b) => a.name.localeCompare(b.name));
  for (const b of branches) b.current = b.name === local.current;
  // The fetch above moved remote-tracking refs: hand the refreshed history
  // back so the caller persists it instead of throwing it away.
  const snapshot = await snapshotGitDir(fs).catch(() => opts.snapshot);
  return { current: local.current, branches, output: localR.stdout, snapshot };
}

/**
 * Create `name` from the current HEAD and push `-u origin`, keeping dirty
 * worktree edits as uncommitted changes (checkout -b moves HEAD only).
 */
export async function createBranch(opts: {
  token: string;
  files: FileMap;
  snapshot: GitSnapshot | null;
  skippedPaths?: string[];
  meta: GitMeta;
  name: string;
  identity: Identity;
}): Promise<{
  files: FileMap;
  snapshot: GitSnapshot | null;
  skippedPaths: string[];
  branch: string;
  output: string;
}> {
  const name = validateBranchName(opts.name);
  if (!opts.snapshot || Object.keys(opts.snapshot).length === 0) {
    throw new Error("no git history stored for this session");
  }
  const fs = await rehydrate(opts);
  const git = gitFor(fs, WORKTREE, opts.token, opts.identity);
  let out = "";
  const co = await exec(git as never, `checkout -b ${quote(name)}`);
  out += co.stdout + co.stderr;
  if (!co.ok) throw new Error(`could not create branch ${name}: ${(co.stderr || co.stdout).slice(0, 500)}`);
  const push = await exec(git as never, `push -u origin ${quote(name)}`);
  out += push.stdout + push.stderr;
  if (!push.ok) {
    // The local branch exists even though the push failed: persist it — and
    // the new branch name — so the link stops pointing at the old branch and
    // the next commit goes to the checkout the user is actually on.
    const synced = await syncBack(fs, opts);
    const detail = (push.stderr || push.stdout).slice(0, 800);
    const err = new Error(
      `branch ${name} created locally but the push failed: ${pushFailureHint(detail, { login: opts.identity.name, owner: opts.meta.owner, repo: opts.meta.repo })}`,
    );
    throw Object.assign(err, { partial: { ...synced, branch: name } });
  }
  const synced = await syncBack(fs, opts);
  return { ...synced, branch: name, output: out };
}

/**
 * Resolve a picker selection to a checkout target.
 *
 * The picker lists remote-tracking entries as `origin/<name>`; checking out
 * that ref directly detaches HEAD. When the full name is not a local branch,
 * strip one `origin/` prefix so git checks out (or creates, tracking) the
 * local branch instead. A local branch that literally starts with `origin/`
 * still wins when it exists.
 */
export function resolveSwitchTarget(localNames: string[], requested: string): string {
  if (localNames.includes(requested)) return requested;
  if (requested.startsWith("origin/")) {
    const short = requested.slice("origin/".length);
    if (short) return short;
  }
  return requested;
}

/** Switch the checkout to an existing local or remote-tracking branch. */
export async function switchBranch(opts: {
  token: string;
  files: FileMap;
  snapshot: GitSnapshot | null;
  skippedPaths?: string[];
  meta: GitMeta;
  name: string;
  identity: Identity;
}): Promise<{
  files: FileMap;
  snapshot: GitSnapshot | null;
  skippedPaths: string[];
  branch: string;
  output: string;
}> {
  const name = validateBranchName(opts.name);
  if (!opts.snapshot || Object.keys(opts.snapshot).length === 0) {
    throw new Error("no git history stored for this session");
  }
  const fs = await rehydrate(opts);
  const git = gitFor(fs, WORKTREE, opts.token, opts.identity);
  // Fetch first (best-effort) so a remote branch created since the last
  // branch-list refresh still resolves to a tracking branch below.
  try {
    await exec(git as never, "fetch origin");
  } catch {
    /* checkout still works off local state */
  }
  const localList = await exec(git as never, "branch");
  const locals = localList.ok
    ? parseBranchLines(localList.stdout, false).branches.map((b) => b.name)
    : [];
  const target = resolveSwitchTarget(locals, name);
  const r = await exec(git as never, `checkout ${quote(target)}`);
  const output = r.stdout + r.stderr;
  if (!r.ok) {
    throw new Error(
      `could not switch to ${name}: ${output.slice(0, 800)}` +
        (/would be overwritten|local changes|needs merge|error: /i.test(output)
          ? " Commit or stash your changes, then retry."
          : ""),
    );
  }
  const branch = await currentBranch(fs, opts.token, opts.identity);
  if (!branch) {
    throw new Error(
      `switching to ${name} left HEAD detached — checked out the remote-tracking ref instead of a local branch. Pick a local branch from the picker.`,
    );
  }
  const synced = await syncBack(fs, opts);
  const note = target !== name ? `resolved ${name} to local branch ${target}.\n` : "";
  return { ...synced, branch, output: note + output };
}

/**
 * Delete a merged `proto/*` branch locally plus `push origin --delete`.
 * `-d` (not `-D`) refuses unmerged branches; a missing remote ref counts as
 * already deleted.
 */
export async function deleteBranch(opts: {
  token: string;
  files: FileMap;
  snapshot: GitSnapshot | null;
  skippedPaths?: string[];
  meta: GitMeta;
  name: string;
  identity: Identity;
}): Promise<{
  files: FileMap;
  snapshot: GitSnapshot | null;
  skippedPaths: string[];
  branch: string | null;
  output: string;
}> {
  const name = validateBranchName(opts.name);
  if (!name.startsWith("proto/")) {
    throw new Error(`refusing to delete ${name}: only proto/* branches can be deleted here`);
  }
  if (["main", "master"].includes(name)) throw new Error(`refusing to delete ${name}`);
  if (!opts.snapshot || Object.keys(opts.snapshot).length === 0) {
    throw new Error("no git history stored for this session");
  }
  const fs = await rehydrate(opts);
  const git = gitFor(fs, WORKTREE, opts.token, opts.identity);
  let out = "";
  const cur = await currentBranch(fs, opts.token, opts.identity);
  if (cur === name) {
    throw new Error(`cannot delete ${name}: it is the current branch — switch to another branch first`);
  }
  const del = await exec(git as never, `branch -d ${quote(name)}`);
  out += del.stdout + del.stderr;
  if (!del.ok) {
    throw new Error(
      `could not delete ${name}: ${(del.stderr || del.stdout).slice(0, 500)}` +
        (/not fully merged/i.test(del.stdout + del.stderr)
          ? " Merge it first, or delete it explicitly with: git branch -D " + name
          : ""),
    );
  }
  const push = await exec(git as never, `push origin --delete ${quote(name)}`);
  out += push.stdout + push.stderr;
  if (!push.ok && !/remote ref does not exist|no such ref/i.test(push.stdout + push.stderr)) {
    const synced = await syncBack(fs, opts);
    const detail = (push.stderr || push.stdout).slice(0, 800);
    throw Object.assign(
      new Error(
        `deleted ${name} locally but the remote delete failed: ${pushFailureHint(detail, { login: opts.identity.name, owner: opts.meta.owner, repo: opts.meta.repo })}`,
      ),
      { partial: synced },
    );
  }
  const synced = await syncBack(fs, opts);
  return { ...synced, branch: await currentBranch(fs, opts.token, opts.identity), output: out };
}
