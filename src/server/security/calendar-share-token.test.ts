import { describe, expect, it } from "vitest";

import {
  createCalendarShareToken,
  verifyCalendarShareToken,
} from "./calendar-share-token";
import { createShareToken, verifyShareToken } from "./share-token";

const raidTeamId = "cmh1qweasdf67890";

describe("calendar-share-token", () => {
  it("round-trips raidTeamId + view", () => {
    const { token } = createCalendarShareToken({ raidTeamId, view: "month", ttlDays: 7 });
    const v = verifyCalendarShareToken(token);
    expect(v).not.toBeNull();
    expect(v!.raidTeamId).toBe(raidTeamId);
    expect(v!.view).toBe("month");
  });

  it("rejects a tampered payload", () => {
    const { token } = createCalendarShareToken({ raidTeamId, view: "agenda" });
    const [ver, , sig] = token.split(".");
    const tampered = `${ver}.${Buffer.from('{"r":"other","v":"month"}').toString("base64url")}.${sig}`;
    expect(verifyCalendarShareToken(tampered)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const { token } = createCalendarShareToken({ raidTeamId, view: "agenda" });
    expect(verifyCalendarShareToken(token.slice(0, -3) + "AAA")).toBeNull();
  });

  it("rejects an expired/replayed token (payload swap invalidates the sig)", () => {
    const { token } = createCalendarShareToken({ raidTeamId, view: "agenda", ttlDays: 1 });
    const [, , sig] = token.split(".");
    const expired = Buffer.from(
      JSON.stringify({ r: raidTeamId, v: "agenda", e: 0 }),
    ).toString("base64url");
    expect(verifyCalendarShareToken(`c1.${expired}.${sig}`)).toBeNull();
    expect(verifyCalendarShareToken(token)).not.toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyCalendarShareToken("")).toBeNull();
    expect(verifyCalendarShareToken("not-a-token")).toBeNull();
    expect(verifyCalendarShareToken("c1.bad")).toBeNull();
    expect(verifyCalendarShareToken("c2.foo.bar")).toBeNull();
  });

  it("never expires when ttlDays is omitted; view defaults to agenda", () => {
    const { token, expiresAt } = createCalendarShareToken({ raidTeamId, view: "agenda" });
    expect(expiresAt).toBeNull();
    const v = verifyCalendarShareToken(token);
    expect(v!.expiresAt).toBeNull();
    expect(v!.view).toBe("agenda");
  });

  it("clamps ttlDays to the 366-day maximum", () => {
    const { expiresAt } = createCalendarShareToken({ raidTeamId, view: "month", ttlDays: 9999 });
    const days = (expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(366);
    expect(days).toBeGreaterThan(365);
  });

  it("does NOT cross-verify with dashboard (v1) tokens despite the shared secret", () => {
    const dash = createShareToken({ dashboardId: "d", raidTeamId, ttlDays: 7 });
    expect(verifyCalendarShareToken(dash.token)).toBeNull();
    const cal = createCalendarShareToken({ raidTeamId, view: "month", ttlDays: 7 });
    expect(verifyShareToken(cal.token)).toBeNull();
  });
});
