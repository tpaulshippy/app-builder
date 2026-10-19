import { describe, expect, it } from "vitest";

import {
  INVITE_TTL_MS,
  MAX_AUDIT,
  MEMBER_SECRET_RE,
  INVITE_CODE_RE,
  buildInvite,
  capAudit,
  checkBaseVersion,
  genInviteCode,
  genMemberSecret,
  isInviteValid,
  publicShareStatus,
  resolveRebuiltAuthor,
  turnBusyError,
  type ShareState,
} from "../src/share";

describe("share helpers", () => {
  it("mints 12-char invite codes from crypto randomness", () => {
    const fixed = (n: number) => Uint8Array.from({ length: n }, (_, i) => i * 7);
    expect(genInviteCode(fixed)).toMatch(INVITE_CODE_RE);
    for (let i = 0; i < 50; i++) {
      expect(genInviteCode()).toMatch(INVITE_CODE_RE);
    }
  });

  it("mints 32-char member secrets", () => {
    const fixed = (n: number) => Uint8Array.from({ length: n }, (_, i) => i);
    const secret = genMemberSecret(fixed);
    expect(secret).toMatch(MEMBER_SECRET_RE);
    expect(genMemberSecret()).toMatch(MEMBER_SECRET_RE);
  });

  it("builds 24h invites and enforces the expiry boundary", () => {
    const now = 1_000_000;
    const invite = buildInvite("Ab3dEf7hJk9M", now);
    expect(invite.expiresAt - invite.createdAt).toBe(INVITE_TTL_MS);
    expect(isInviteValid(invite, now + INVITE_TTL_MS - 1)).toBe(true);
    expect(isInviteValid(invite, now + INVITE_TTL_MS)).toBe(false);
    expect(isInviteValid(null, now)).toBe(false);
    expect(isInviteValid({ code: "bad", createdAt: now, expiresAt: now + 1000 }, now)).toBe(false);
  });

  it("caps the audit trail at the default maximum", () => {
    const list = Array.from({ length: MAX_AUDIT + 25 }, (_, i) => i);
    const capped = capAudit(list);
    expect(capped).toHaveLength(MAX_AUDIT);
    expect(capped[0]).toBe(0);
    expect(capped[MAX_AUDIT - 1]).toBe(MAX_AUDIT - 1);
    expect(capAudit([1, 2, 3], 2)).toEqual([1, 2]);
  });

  it("guards whole-FileMap saves by version", () => {
    expect(checkBaseVersion(7, undefined)).toEqual({ ok: true });
    expect(checkBaseVersion(7, 7)).toEqual({ ok: true });
    const stale = checkBaseVersion(8, 7);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toMatch(/teammate edited — reload/);
    const bad = checkBaseVersion(8, "7");
    expect(bad.ok).toBe(false);
  });

  it("names the running actor in turn conflicts without implying a queue", () => {
    expect(turnBusyError("son")).toContain("son");
    expect(turnBusyError("son")).toMatch(/wait for it to finish, then retry your save/);
    expect(turnBusyError("son")).not.toMatch(/queued/);
    expect(turnBusyError(null)).toContain("an agent turn is in progress");
  });

  it("preserves authors across the Pi transcript sync", () => {
    expect(resolveRebuiltAuthor("dad", true, "son")).toBe("dad");
    expect(resolveRebuiltAuthor("dad", false, "son")).toBe("dad");
    expect(resolveRebuiltAuthor(undefined, true, "son")).toBe("son");
    expect(resolveRebuiltAuthor(undefined, false, "son")).toBe(undefined);
    expect(resolveRebuiltAuthor(undefined, true, null)).toBe(undefined);
  });

  it("projects share status without secrets and with owner-only codes", () => {
    const turn = { active: false, actor: null, startedAt: null, queued: 0 };
    const secretOwner = "o".repeat(32);
    const secretMember = "m".repeat(32);
    const share: ShareState = {
      enabled: true,
      owner: { userId: 1, login: "dad" },
      members: [
        { id: secretOwner, userId: 1, login: "dad", role: "owner", joinedAt: 1 },
        { id: secretMember, userId: 2, login: "son", role: "member", joinedAt: 2 },
      ],
      invite: { code: "Ab3dEf7hJk9M", createdAt: 1, expiresAt: Date.now() + 1000 },
    };
    const ownerView = publicShareStatus(share, turn, [], 3, true);
    expect(ownerView.shared).toBe(true);
    expect(ownerView.invite?.code).toBe("Ab3dEf7hJk9M");
    expect(JSON.stringify(ownerView)).not.toContain(secretOwner);
    expect(JSON.stringify(ownerView)).not.toContain(secretMember);
    const memberView = publicShareStatus(share, turn, [], 3, false);
    expect(memberView.invite).toBeNull();
    expect(memberView.members).toEqual([
      { login: "dad", role: "owner", joinedAt: 1 },
      { login: "son", role: "member", joinedAt: 2 },
    ]);
    expect(JSON.stringify(memberView)).not.toContain(secretOwner);
  });
});
