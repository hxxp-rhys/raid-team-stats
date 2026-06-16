import { describe, expect, it } from "vitest";

import {
  decayChipOf,
  dedupePulls,
  isThrowaway,
  nightBuckets,
  nightsOf,
  paceOf,
  progressOf,
  rollingBest,
  slopeOf,
  type Pull,
} from "./prog-curve";

const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 5, 10, 0, 0, 0); // 2026-06-10 00:00 UTC

const pull = (over: Partial<Pull>): Pull => ({
  reportCode: "r1",
  fightId: 1,
  encounterId: 3306,
  difficulty: 5,
  kill: false,
  bossPct: 50,
  fightPct: 60,
  lastPhase: 1,
  startAt: BASE,
  endAt: BASE + 300_000,
  durationMs: 300_000,
  reportDurationMs: 4 * HOUR,
  ...over,
});

describe("dedupePulls", () => {
  it("collapses the same pull logged by two reports, keeping longer coverage", () => {
    const a = pull({ reportCode: "short", reportDurationMs: 2 * HOUR });
    const b = pull({
      reportCode: "long",
      reportDurationMs: 5 * HOUR,
      startAt: BASE + 4_000, // within ±10s
      endAt: BASE + 4_000 + 302_000,
      durationMs: 302_000, // within ±5s
    });
    const out = dedupePulls([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.reportCode).toBe("long");
  });

  it("keeps near-simultaneous pulls of DIFFERENT bosses", () => {
    const a = pull({ encounterId: 1 });
    const b = pull({ encounterId: 2, startAt: BASE + 2_000 });
    expect(dedupePulls([a, b])).toHaveLength(2);
  });

  it("never merges two pulls from the SAME report", () => {
    const a = pull({ fightId: 1 });
    const b = pull({ fightId: 2, startAt: BASE + 3_000 });
    expect(dedupePulls([a, b])).toHaveLength(2);
  });

  it("keeps same-boss pulls at DIFFERENT difficulties", () => {
    const a = pull({ reportCode: "r1", difficulty: 5 });
    const b = pull({ reportCode: "r2", difficulty: 4, startAt: BASE + 2_000 });
    expect(dedupePulls([a, b])).toHaveLength(2);
  });
});

describe("progressOf", () => {
  it("kills are always 100, regardless of stored percentages", () => {
    expect(progressOf(pull({ kill: true, fightPct: 37 }))).toBe(100);
  });
  it("uses the phase-aware axis by default, HP axis on toggle", () => {
    const p = pull({ fightPct: 60, bossPct: 80 });
    expect(progressOf(p, "fight")).toBe(40);
    expect(progressOf(p, "boss")).toBe(20);
  });
  it("falls back across axes and clamps", () => {
    expect(progressOf(pull({ fightPct: null, bossPct: 30 }), "fight")).toBe(70);
    expect(progressOf(pull({ fightPct: null, bossPct: null }))).toBe(0);
  });
});

describe("isThrowaway", () => {
  it("flags sub-25s pulls and short barely-scratched resets", () => {
    expect(isThrowaway(pull({ durationMs: 10_000 }))).toBe(true);
    expect(
      isThrowaway(pull({ durationMs: 40_000, fightPct: 99.5 })),
    ).toBe(true);
  });
  it("keeps real attempts and all kills", () => {
    expect(isThrowaway(pull({ durationMs: 200_000, fightPct: 60 }))).toBe(
      false,
    );
    // long but barely scratched — a real (bad) attempt, not a reset
    expect(isThrowaway(pull({ durationMs: 90_000, fightPct: 99.5 }))).toBe(
      false,
    );
    expect(isThrowaway(pull({ kill: true, durationMs: 10_000 }))).toBe(false);
  });
});

describe("nightsOf", () => {
  it("an exactly-6h gap stays one night; just over splits", () => {
    const a = pull({ startAt: BASE, endAt: BASE + 300_000 });
    const atSix = pull({
      startAt: BASE + 300_000 + 6 * HOUR,
      endAt: BASE + 300_000 + 6 * HOUR + 300_000,
    });
    expect(nightsOf([a, atSix])).toHaveLength(1);
    const justOver = pull({
      startAt: BASE + 300_000 + 6 * HOUR + 1,
      endAt: BASE + 300_000 + 6 * HOUR + 300_001,
    });
    expect(nightsOf([a, justOver])).toHaveLength(2);
  });

  it("splits on >6h gaps and keeps chronological order", () => {
    const n1a = pull({ startAt: BASE, endAt: BASE + 300_000 });
    const n1b = pull({ startAt: BASE + HOUR, endAt: BASE + HOUR + 300_000 });
    const n2 = pull({ startAt: BASE + 12 * HOUR, endAt: BASE + 12 * HOUR + 300_000 });
    const nights = nightsOf([n2, n1b, n1a]); // shuffled input
    expect(nights).toHaveLength(2);
    expect(nights[0]).toHaveLength(2);
    expect(nights[0]![0]!.startAt).toBe(BASE);
  });
});

describe("nightBuckets", () => {
  it("returns first-index, start time, and count per night (chronological)", () => {
    const n1a = pull({ startAt: BASE, endAt: BASE + 300_000 });
    const n1b = pull({ startAt: BASE + HOUR, endAt: BASE + HOUR + 300_000 });
    const n2a = pull({ startAt: BASE + 12 * HOUR, endAt: BASE + 12 * HOUR + 300_000 });
    const buckets = nightBuckets([n2a, n1b, n1a]); // shuffled input
    expect(buckets).toEqual([
      {
        firstIndex: 0,
        lastIndex: 1,
        startAt: BASE,
        endAt: BASE + HOUR + 300_000, // last pull of night 1 ends here
        count: 2,
      },
      {
        firstIndex: 2,
        lastIndex: 2,
        startAt: BASE + 12 * HOUR,
        endAt: BASE + 12 * HOUR + 300_000,
        count: 1,
      },
    ]);
  });
  it("empty → []", () => {
    expect(nightBuckets([])).toEqual([]);
  });
});

describe("rollingBest + slopeOf", () => {
  it("rollingBest is a running max", () => {
    expect(rollingBest([10, 5, 30, 20])).toEqual([10, 10, 30, 30]);
  });
  it("slopeOf fits the trailing window", () => {
    expect(slopeOf([0, 10, 20, 30])).toBeCloseTo(10);
    expect(slopeOf([50, 50, 50])).toBeCloseTo(0);
    expect(slopeOf([1, 2])).toBeNull(); // <3 points
  });

  it("slopeOf only sees the trailing 15 values", () => {
    // 20 declining values then 15 rising ones: full-series fit would be
    // dragged down; the trailing-15 window must report the rise.
    const series = [
      ...Array.from({ length: 20 }, (_, i) => 100 - i * 4),
      ...Array.from({ length: 15 }, (_, i) => i * 5),
    ];
    expect(slopeOf(series)).toBeCloseTo(5);
  });
});

describe("paceOf", () => {
  it("counts breaks (>20min) and computes pulls per ACTIVE hour", () => {
    // 4 pulls of 10 min back-to-back, then a 30-min break, then 2 more.
    const mk = (startMin: number) =>
      pull({
        startAt: BASE + startMin * 60_000,
        endAt: BASE + (startMin + 10) * 60_000,
        durationMs: 10 * 60_000,
      });
    const night = [mk(0), mk(10), mk(20), mk(30), mk(70), mk(80)];
    const pace = paceOf(night);
    expect(pace.pulls).toBe(6);
    expect(pace.breaks).toHaveLength(1);
    expect(pace.spanMs).toBe(90 * 60_000);
    // active = 90 - 30 = 60 min → 6 pulls/hr
    expect(pace.pullsPerHour).toBeCloseTo(6);
  });
  it("handles an empty night", () => {
    expect(paceOf([]).pullsPerHour).toBeNull();
  });
});

describe("decayChipOf", () => {
  const mk = (startMin: number, fightPct: number) =>
    pull({
      startAt: BASE + startMin * 60_000,
      endAt: BASE + (startMin + 5) * 60_000,
      durationMs: 5 * 60_000,
      fightPct,
    });

  it("returns the final-hour vs night delta for the most-pulled boss", () => {
    // 10 pulls over ~2.5h: early pulls reach 40-50% progress, the last
    // five (inside the final hour) only 10-20%.
    const night = [
      mk(0, 60), mk(15, 55), mk(30, 50), mk(45, 55), mk(60, 50),
      mk(95, 85), mk(110, 90), mk(125, 85), mk(140, 90), mk(150, 80),
    ];
    const chip = decayChipOf(night);
    expect(chip).not.toBeNull();
    expect(chip!.delta).toBeLessThan(0);
  });

  it("stays null on small samples (most nights)", () => {
    expect(decayChipOf([mk(0, 50), mk(15, 60), mk(30, 55)])).toBeNull();
  });

  it("compares the MOST-PULLED boss, not whichever came last", () => {
    const prog = [
      mk(0, 60), mk(15, 55), mk(30, 50), mk(60, 50), mk(75, 55), mk(95, 85),
      mk(110, 90), mk(125, 85), mk(140, 90), mk(150, 80),
    ]; // 10 pulls on the default encounter
    const farm = [
      { ...mk(35, 0), encounterId: 999, kill: true },
      { ...mk(45, 0), encounterId: 999, kill: true },
    ];
    const chip = decayChipOf([...farm, ...prog]);
    expect(chip).not.toBeNull();
    expect(chip!.encounterId).toBe(3306);
  });

  it("anchors the final hour to the NIGHT's end — farm after prog → null", () => {
    // 10 prog pulls ending at minute 155, then an hour of farm on another
    // boss. The night's final hour contains no prog pulls, so under the
    // night-anchored definition the chip honestly declines to speak.
    const prog = [
      mk(0, 60), mk(15, 55), mk(30, 50), mk(45, 55), mk(60, 50),
      mk(95, 85), mk(110, 90), mk(125, 85), mk(140, 90), mk(150, 80),
    ];
    const farm = Array.from({ length: 3 }, (_, i) => ({
      ...mk(170 + i * 20, 0),
      encounterId: 999,
      kill: true,
    }));
    expect(decayChipOf([...prog, ...farm])).toBeNull();
  });
});
