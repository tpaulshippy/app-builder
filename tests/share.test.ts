import { describe, expect, it } from "vitest";

import {
  MEMBER_SECRET_RE,
  INVITE_CODE_RE,
  capAudit,
  checkBaseVersion,
  genInviteCode,
  genMemberSecret,
  isInviteValid,
  turnBusyError,
} from "../src/share";

describe("share helpers", () => {
  it("mints 12-char invite codes", () => {
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

  it("expires invites after 24h", () => {
    const now = Date.now();
    const invite = { code: "Ab3dEf7hJk9M", createdAt: now, expiresAt: now + 1000 };
    expect(isInviteValid(invite, now)).toBe(true);
    expect(isInviteValid(invite, now + 1001)).toBe(false);
    expect(isInviteValid(null, now)).toBe(false);
    expect(isInviteValid({ code: "bad", createdAt: now, expiresAt: now + 1000 }, now)).toBe(false);
  });

  it("caps the audit trail", () => {
    const list = [1, 2, 3, 4];
    expect(capAudit(list, 2)).toEqual([1, 2]);
    expect(capAudit(list)).toEqual(list);
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

  it("names the running actor in turn conflicts", () => {
    expect(turnBusyError("son")).toContain("son");
    expect(turnBusyError(null)).toContain("an agent turn is in progress");
  });
});
