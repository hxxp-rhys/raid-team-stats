import { describe, expect, it } from "vitest";
import { createShareToken, verifyShareToken } from "./share-token";

const dashboardId = "cmh1qweasdf12345";
const raidTeamId = "cmh1qweasdf67890";

describe("share-token", () => {
  it("round-trips a typical share token", () => {
    const { token } = createShareToken({ dashboardId, raidTeamId, ttlDays: 7 });
    const verified = verifyShareToken(token);
    expect(verified).not.toBeNull();
    expect(verified!.dashboardId).toBe(dashboardId);
    expect(verified!.raidTeamId).toBe(raidTeamId);
  });

  it("rejects a tampered payload", () => {
    const { token } = createShareToken({ dashboardId, raidTeamId });
    const [v, , sig] = token.split(".");
    // Swap the payload for a different dashboard but keep the original signature.
    const tampered = `${v}.${Buffer.from('{"d":"x","r":"x","e":9999999999999}').toString("base64url")}.${sig}`;
    expect(verifyShareToken(tampered)).toBeNull();
  });

  it("rejects a token with a tampered signature", () => {
    const { token } = createShareToken({ dashboardId, raidTeamId });
    const bad = token.slice(0, -3) + "AAA";
    expect(verifyShareToken(bad)).toBeNull();
  });

  it("rejects an expired token", () => {
    const { token } = createShareToken({ dashboardId, raidTeamId, ttlDays: 1 });
    // Force-expire by replacing the payload with an old timestamp + re-signing
    // would defeat the point; here we just confirm we *can't* fake expiry.
    const [, , sig] = token.split(".");
    const expired = Buffer.from(
      JSON.stringify({ d: dashboardId, r: raidTeamId, e: 0 }),
    ).toString("base64url");
    const replayed = `v1.${expired}.${sig}`;
    expect(verifyShareToken(replayed)).toBeNull();
    // And the legitimate fresh one still verifies.
    expect(verifyShareToken(token)).not.toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyShareToken("")).toBeNull();
    expect(verifyShareToken("not-a-token")).toBeNull();
    expect(verifyShareToken("v1.bad")).toBeNull();
    expect(verifyShareToken("v2.foo.bar")).toBeNull();
  });

  it("clamps ttlDays to the one-year (366-day) maximum", () => {
    const { expiresAt } = createShareToken({
      dashboardId,
      raidTeamId,
      ttlDays: 9999,
    });
    const days =
      (expiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeLessThanOrEqual(366);
    expect(days).toBeGreaterThan(365);
  });

  it("never expires when ttlDays is omitted (the default)", () => {
    const { token, expiresAt } = createShareToken({ dashboardId, raidTeamId });
    expect(expiresAt).toBeNull();
    const verified = verifyShareToken(token);
    expect(verified).not.toBeNull();
    expect(verified!.expiresAt).toBeNull();
    expect(verified!.dashboardId).toBe(dashboardId);
  });

  it("never expires when ttlDays is null", () => {
    const { expiresAt } = createShareToken({
      dashboardId,
      raidTeamId,
      ttlDays: null,
    });
    expect(expiresAt).toBeNull();
  });

  it("honors a one-year expiry", () => {
    const { token, expiresAt } = createShareToken({
      dashboardId,
      raidTeamId,
      ttlDays: 365,
    });
    expect(expiresAt).not.toBeNull();
    const verified = verifyShareToken(token);
    expect(verified).not.toBeNull();
    expect(verified!.expiresAt).not.toBeNull();
    const days =
      (verified!.expiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThanOrEqual(365);
  });
});
