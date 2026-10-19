/**
 * Live shared playground (issue #30): pure helpers with no Worker/DO
 * dependencies, unit-tested in tests/share.test.ts.
 *
 * Model: one playground is one Durable Object. Members join by invite code;
 * each browser keeps its own `ab_member` secret, and each member links their
 * own GitHub token. The owner's cookie is never shared — joining mints a new
 * credential instead of copying the session id.
 */

export const MEMBER_COOKIE = "ab_member";
export const INVITE_CODE_RE = /^[A-Za-z0-9]{12}$/;
export const MEMBER_SECRET_RE = /^[A-Za-z0-9_-]{32}$/;

/** Invite codes live 24h; rotation/revoke is createInvite again. */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/** Audit trail cap per playground (server keeps newest-first, trimmed). */
export const MAX_AUDIT = 100;

export type ShareRole = "owner" | "member";

export type ShareMember = {
  /** Random per-browser credential id; the cookie holds the secret itself. */
  id: string;
  userId: number | null;
  login: string | null;
  role: ShareRole;
  joinedAt: number;
};

export type ShareInvite = {
  code: string;
  createdAt: number;
  expiresAt: number;
};

export type ShareState = {
  enabled: boolean;
  owner: { userId: number; login: string };
  members: ShareMember[];
  invite: ShareInvite | null;
};

export type ShareAuditEntry = {
  at: number;
  actor: string;
  action: string;
  detail?: string;
};

export type TurnInfo = {
  active: boolean;
  /** Login of the member running the turn, or null for legacy/unknown. */
  actor: string | null;
  startedAt: number | null;
  /** Requests waiting behind the active turn. */
  queued: number;
};

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function genInviteCode(random: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < 12; i++) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return out;
}

export function genMemberSecret(randomValues: (n: number) => Uint8Array = defaultRandomValues): string {
  const bytes = randomValues(32);
  let out = "";
  for (const b of bytes) out += "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".charAt(b & 63);
  return out;
}

function defaultRandomValues(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function isInviteValid(invite: ShareInvite | null, now: number = Date.now()): boolean {
  if (!invite || !INVITE_CODE_RE.test(invite.code)) return false;
  return now < invite.expiresAt;
}

/** Newest-first audit trim shared by session recordAudit and tests. */
export function capAudit<T>(list: T[], max: number = MAX_AUDIT): T[] {
  return list.slice(0, Math.max(0, max));
}

/**
 * Optimistic-concurrency guard for whole-FileMap saves: the client sends the
 * `version` it rendered from, and a mismatch means a teammate (or an agent
 * turn) persisted first. The caller must adopt the returned files and prompt
 * reload — last-writer-wins with a reload prompt, never a silent overwrite.
 */
export function checkBaseVersion(
  stored: number,
  base: unknown,
): { ok: true } | { ok: false; error: string } {
  if (base === undefined || base === null) return { ok: true };
  if (typeof base !== "number" || !Number.isInteger(base)) {
    return { ok: false, error: "expected a numeric files version — reload and retry" };
  }
  if (base !== stored) {
    return { ok: false, error: "teammate edited — reload: files changed since you loaded them, your copy is stale" };
  }
  return { ok: true };
}

/** Queue/waiting error naming the running actor (null = legacy wording). */
export function turnBusyError(actor: string | null): string {
  return actor
    ? `an agent turn is running (${actor}) — your request is queued, wait for it to finish, then retry`
    : "an agent turn is in progress — wait for it to finish, then retry";
}
