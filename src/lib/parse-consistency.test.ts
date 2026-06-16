import { describe, expect, it } from "vitest";

import {
  bandOf,
  extractKillRanks,
  roleOf,
  slopeBadge,
  stdevOf,
  theilSen,
} from "./parse-consistency";

describe("extractKillRanks", () => {
  it("pulls {t, pct} from each kill, tolerating top-level or report.startTime and rankPercent/percentile", () => {
    const raw = {
      season: { totalKills: 3 },
      ranks: [
        { startTime: 1000, rankPercent: 90.5 }, // top-level startTime
        { report: { startTime: 2000 }, percentile: 80 }, // nested time + percentile fallback
        { rankPercent: 70 }, // no time → dropped
        { startTime: 3000 }, // no pct → dropped
      ],
    };
    expect(extractKillRanks(raw)).toEqual([
      { t: 1000, pct: 90.5 },
      { t: 2000, pct: 80 },
    ]);
  });
  it("missing / malformed ranks → []", () => {
    expect(extractKillRanks(null)).toEqual([]);
    expect(extractKillRanks({})).toEqual([]);
    expect(extractKillRanks({ ranks: "nope" })).toEqual([]);
  });
});

describe("stdevOf", () => {
  it("computes sample stdev", () => {
    expect(stdevOf([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(stdevOf([50, 50, 50])).toBe(0);
  });
  it("needs at least 2 values", () => {
    expect(stdevOf([42])).toBeNull();
    expect(stdevOf([])).toBeNull();
  });
});

describe("theilSen", () => {
  it("recovers a clean linear slope", () => {
    expect(theilSen([10, 20, 30, 40])).toBeCloseTo(10);
    expect(theilSen([60, 60, 60])).toBeCloseTo(0);
  });
  it("is robust to a single outlier week (the reason it was chosen)", () => {
    // Steady +2/week with one disastrous week: least-squares would swing
    // hard; the pairwise median barely moves.
    const ts = theilSen([50, 52, 5, 56, 58, 60]);
    expect(ts).toBeGreaterThan(1);
    expect(ts).toBeLessThan(4);
  });
  it("needs ≥3 points", () => {
    expect(theilSen([1, 2])).toBeNull();
  });
});

describe("roleOf", () => {
  it("maps healer and tank specs by name, case-insensitively", () => {
    expect(roleOf("Restoration")).toBe("healer");
    expect(roleOf("holy")).toBe("healer");
    expect(roleOf("Mistweaver")).toBe("healer");
    expect(roleOf("Preservation")).toBe("healer");
    expect(roleOf("Protection")).toBe("tank");
    expect(roleOf("Blood")).toBe("tank");
    expect(roleOf("Vengeance")).toBe("tank");
  });
  it("defaults everything else (and unknown) to dps", () => {
    expect(roleOf("Fury")).toBe("dps");
    expect(roleOf("Shadow")).toBe("dps");
    expect(roleOf(null)).toBe("dps");
    expect(roleOf(undefined)).toBe("dps");
  });
});

describe("bandOf", () => {
  it("matches the WCL band boundaries", () => {
    expect(bandOf(100)).toBe("gold");
    expect(bandOf(99)).toBe("pink");
    expect(bandOf(95)).toBe("orange");
    expect(bandOf(94.9)).toBe("purple");
    expect(bandOf(75)).toBe("purple");
    expect(bandOf(50)).toBe("blue");
    expect(bandOf(25)).toBe("green");
    expect(bandOf(24.9)).toBe("grey");
  });
});

describe("slopeBadge", () => {
  it("thresholds at ±1.5 points/week", () => {
    expect(slopeBadge(2)).toBe("up");
    expect(slopeBadge(1.5)).toBe("up");
    expect(slopeBadge(1.4)).toBe("flat");
    expect(slopeBadge(-1.4)).toBe("flat");
    expect(slopeBadge(-1.5)).toBe("down");
    expect(slopeBadge(null)).toBeNull();
  });
});
