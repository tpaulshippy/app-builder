/** Reject absolute paths, traversal, and shell metacharacters in file keys. */
export function isSafePath(key: string): boolean {
  return /^[\w./-]+$/.test(key) && !key.includes("..") && !key.startsWith("/");
}
