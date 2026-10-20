/**
 * GitHub-keyed session identity: one Durable Object per GitHub user
 * (`gh-<id>`), shared across that user's browsers/devices so a session picks
 * up where it left off. The cookie bearer is `<canonicalId>.<secret>`; the
 * id alone is public (it is the GitHub user id) and proves nothing — every
 * request must verify the unguessable secret against the allowlist.
 *
 * Dependency-free on purpose: the edge Worker imports this without pulling
 * in the heavy Durable Object module (which tests mock out).
 */

export const GITHUB_SESSION_PREFIX = "gh-";

const SECRET_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CANONICAL_ID_RE = /^gh-\d{1,20}$/;
const CANONICAL_BEARER_RE = /^gh-(\d{1,20})\.([A-Za-z0-9_-]{8,64})$/;
/** Canonical Durable Object name for a GitHub user id. */
export function canonicalIdForGithubUser(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`bad github user id: ${id}`);
  return `${GITHUB_SESSION_PREFIX}${id}`;
}

/** True for canonical `gh-<id>` object names (never a device secret). */
export function isCanonicalId(name: string): boolean {
  return CANONICAL_ID_RE.test(name);
}

export type ParsedSessionValue =
  | { kind: "canonical"; canonicalId: string; secret: string }
  | { kind: "legacy"; deviceId: string };

/**
 * Parse an `ab_session` cookie value (or an `sid` param, same shape).
 * Canonical bearers carry the secret after the dot; anything else shaped
 * like the old random id is a legacy per-browser session.
 */
export function parseSessionValue(value: string | null): ParsedSessionValue | null {
  if (!value) return null;
  const m = CANONICAL_BEARER_RE.exec(value);
  if (m) return { kind: "canonical", canonicalId: `${GITHUB_SESSION_PREFIX}${m[1]}`, secret: m[2] as string };
  // A bare canonical id (`gh-<digits>`, no secret) is guessable — it names
  // the victim's own object for longer user ids — so it must never parse as
  // a legacy session. Reject it here; callers treat it as anonymous.
  if (CANONICAL_ID_RE.test(value)) return null;
  if (SECRET_RE.test(value)) return { kind: "legacy", deviceId: value };
  return null;
}
