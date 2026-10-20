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

export function genInviteCode(randomValues: (n: number) => Uint8Array = defaultRandomValues): string {
  const bytes = randomValues(12);
  let out = "";
  for (const b of bytes) out += ALPHABET.charAt(b % ALPHABET.length);
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
    ? `an agent turn is running (${actor}) — wait for it to finish, then retry your save`
    : "an agent turn is in progress — wait for it to finish, then retry";
}

/** Invite record factory so the 24h policy lives in one tested place. */
export function buildInvite(code: string, now: number = Date.now()): ShareInvite {
  return { code, createdAt: now, expiresAt: now + INVITE_TTL_MS };
}

/**
 * Author for one rebuilt user message in the post-turn transcript sync:
 * prefer the matched pre-turn author's label; messages appended beyond the
 * pre-turn history belong to this turn, so they take the turn's actor.
 * Without this, Pi synchronization drops author labels after every turn.
 */
export function resolveRebuiltAuthor(
  priorAuthor: string | undefined,
  isNewTurnMessage: boolean,
  turnAuthor: string | null,
): string | undefined {
  if (priorAuthor) return priorAuthor;
  if (isNewTurnMessage && turnAuthor) return turnAuthor;
  return undefined;
}

/**
 * Client-safe share projection: roster without per-browser secrets, and the
 * live invite code only for the owner (members join with a code the owner
 * hands them; status must not hand it out).
 */
export function publicShareStatus(
  share: ShareState,
  turn: TurnInfo,
  audit: ShareAuditEntry[],
  filesVersion: number,
  viewerIsOwner: boolean,
): {
  shared: boolean;
  members: Array<{ login: string | null; role: string; joinedAt: number }>;
  owner: { userId: number; login: string };
  invite: { code: string; expiresAt: number } | null;
  turn: TurnInfo;
  audit: ShareAuditEntry[];
  filesVersion: number;
} {
  return {
    shared: true,
    members: share.members.map((m) => ({ login: m.login, role: m.role, joinedAt: m.joinedAt })),
    owner: share.owner,
    invite:
      viewerIsOwner && share.invite && isInviteValid(share.invite)
        ? { code: share.invite.code, expiresAt: share.invite.expiresAt }
        : null,
    turn,
    audit: audit.slice(0, 20),
    filesVersion,
  };
}

/**
 * Rotate a playground's invite (pure part): new code, owner identity
 * refreshed to the caller's current login (GitHub logins can change; the
 * caller was already proven to be the owner by user id before this runs),
 * other members untouched.
 */
export function rotateShareInvite(
  prev: ShareState,
  ownerMemberId: string,
  caller: { userId: number; login: string },
  code: string,
  now: number = Date.now(),
): ShareState {
  return {
    ...prev,
    owner: { ...prev.owner, login: caller.login },
    members: prev.members.map((m) =>
      m.id === ownerMemberId ? { ...m, login: caller.login, userId: caller.userId } : m,
    ),
    invite: buildInvite(code, now),
  };
}

/**
 * Whether a preview capability still opens the app endpoints. Solo
 * playgrounds accept any live grant (the edge's object-token gate is the
 * boundary there); once shared, only member-bound grants pass — and only
 * while the member is still on the roster with a linked token, so
 * logout/leave revokes the old iframe immediately. A grant minted while
 * solo (memberId null) dies at the first invite instead of bypassing the
 * member gate.
 */
export function previewGrantValid(
  grant: { memberId: string | null },
  share: ShareState | null,
  memberPresent: boolean,
  memberTokenLinked: boolean,
): boolean {
  if (!share?.enabled) return true;
  if (grant.memberId === null) return false;
  return memberPresent && memberTokenLinked;
}
