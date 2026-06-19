import { describe, expect, it } from "vitest";
import { compareVersions, isOutdated, shouldNotify } from "./companion-release";

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.2.2", "1.2.2")).toBe(0);
    expect(compareVersions("1.0.22.0", "1.0.22.0")).toBe(0);
  });

  it("returns -1 when a is older than b", () => {
    expect(compareVersions("1.0.21.0", "1.0.22.0")).toBe(-1);
    expect(compareVersions("1.2.1", "1.2.2")).toBe(-1);
  });

  it("returns 1 when a is newer than b", () => {
    expect(compareVersions("1.0.22.0", "1.0.21.0")).toBe(1);
    expect(compareVersions("1.2.2", "1.2.1")).toBe(1);
  });

  it("zero-pads the shorter version (segment-count mismatch)", () => {
    expect(compareVersions("1.2.2", "1.2.2.0")).toBe(0);
    expect(compareVersions("1.2.2.0", "1.2.2")).toBe(0);
    expect(compareVersions("1.2", "1.2.0.0")).toBe(0);
  });

  it("compares NUMERICALLY, not lexically", () => {
    // 22 > 9 numerically, but "22" < "9" lexically — must be numeric.
    expect(compareVersions("1.0.9.0", "1.0.22.0")).toBe(-1);
    expect(compareVersions("1.0.22.0", "1.0.9.0")).toBe(1);
    expect(compareVersions("1.0.100.0", "1.0.20.0")).toBe(1);
  });
});

describe("isOutdated", () => {
  it("is true when installed is NUMERICALLY older (not lexical)", () => {
    // 22 > 9, so 1.0.9.0 is outdated relative to 1.0.22.0.
    expect(isOutdated("1.0.9.0", "1.0.22.0")).toBe(true);
  });

  it("is false when installed equals latest", () => {
    expect(isOutdated("1.0.22.0", "1.0.22.0")).toBe(false);
  });

  it("is false when installed is newer than latest", () => {
    expect(isOutdated("1.0.23.0", "1.0.22.0")).toBe(false);
  });

  it("is false for null / undefined / empty installed", () => {
    expect(isOutdated(null, "1.0.22.0")).toBe(false);
    expect(isOutdated(undefined, "1.0.22.0")).toBe(false);
    expect(isOutdated("", "1.0.22.0")).toBe(false);
  });

  it("is false for an unparseable (garbage) installed version", () => {
    expect(isOutdated("garbage", "1.0.22.0")).toBe(false);
    expect(isOutdated("vNext", "1.0.22.0")).toBe(false);
  });
});

describe("shouldNotify", () => {
  const latest = "1.0.22.0";

  it("is true when outdated and not yet notified about this version", () => {
    expect(
      shouldNotify(
        { lastSeenVersion: "1.0.9.0", notifiedUpdateVersion: null },
        latest,
      ),
    ).toBe(true);
  });

  it("is false when outdated but already notified about this exact version", () => {
    expect(
      shouldNotify(
        { lastSeenVersion: "1.0.9.0", notifiedUpdateVersion: "1.0.22.0" },
        latest,
      ),
    ).toBe(false);
  });

  it("is false when up to date", () => {
    expect(
      shouldNotify(
        { lastSeenVersion: "1.0.22.0", notifiedUpdateVersion: null },
        latest,
      ),
    ).toBe(false);
  });

  it("is false when lastSeenVersion is null", () => {
    expect(
      shouldNotify(
        { lastSeenVersion: null, notifiedUpdateVersion: null },
        latest,
      ),
    ).toBe(false);
  });

  it("is true when previously notified an OLDER version and a newer release appears", () => {
    // User was told about 1.0.20.0 before; now 1.0.22.0 is latest and they're
    // still on 1.0.9.0 — they should be notified again.
    expect(
      shouldNotify(
        { lastSeenVersion: "1.0.9.0", notifiedUpdateVersion: "1.0.20.0" },
        latest,
      ),
    ).toBe(true);
  });
});
