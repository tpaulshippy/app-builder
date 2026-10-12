/** Reject absolute paths, traversal, and shell metacharacters in file keys. */
export function isSafePath(key: string): boolean {
  return /^[\w./-]+$/.test(key) && !key.includes("..") && !key.startsWith("/");
}

/**
 * True when any `/`-separated segment is exactly `.git`. `.gitignore` and
 * `.github` are fine (their segment is not `.git`); `foo/.git/config` is not.
 */
export function hasGitSegment(key: string): boolean {
  return key.split("/").some((seg) => seg === ".git");
}
