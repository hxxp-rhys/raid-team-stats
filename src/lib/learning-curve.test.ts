import { describe, expect, it } from "vitest";

import {
  computeLearning,
  parseDamageTakenTable,
  type LearnPull,
} from "./learning-curve";

describe("parseDamageTakenTable", () => {
  it("pulls per-actor totals from the table JSON scalar", () => {
    const raw = {
      data: {
        entries: [
          { id: 7, name: "Bowsmore", total: 1901803, type: "Hunter" },
          { id: 12, name: "Nicolant", total: 1266627 },
          { name: "NoId", total: 5 }, // dropped (no actor id)
          { id: 3 }, // dropped (no total)
        ],
      },
    };
    expect(parseDamageTakenTable(raw)).toEqual([
      { actorId: 7, total: 1901803 },
      { actorId: 12, total: 1266627 },
    ]);
  });
  it("tolerates a missing table / entries", () => {
    expect(parseDamageTakenTable(null)).toEqual([]);
    expect(parseDamageTakenTable({})).toEqual([]);
    expect(parseDamageTakenTable({ data: {} })).toEqual([]);
  });
});

// Helper: build N pulls with a given death pattern (died on the marked idxs).
const pulls = (n: number, diedIdx: Set<number>, surviveMs = 60000): LearnPull[] =>
  Array.from({ length: n }, (_, i) => ({
    died: diedIdx.has(i),
    msIntoPull: diedIdx.has(i) ? surviveMs : null,
  }));

describe("computeLearning", () => {
  it("omits members with too few pulls to bucket fairly", () => {
    const m = new Map<string, LearnPull[]>([["A", pulls(8, new Set())]]); // < 2*6
    expect(computeLearning(m)).toEqual([]);
  });

  it("computes early/late death rates over the chronological halves", () => {
    // 12 pulls: dies on first 4 (early), none later → improving.
    const learner = pulls(12, new Set([0, 1, 2, 3]));
    const [a] = computeLearning(new Map([["A", learner], ["B", pulls(12, new Set([0, 6]))]]));
    expect(a!.earlyPulls).toBe(6);
    expect(a!.latePulls).toBe(6);
    expect(a!.earlyDeathRate).toBeCloseTo(4 / 6);
    expect(a!.lateDeathRate).toBe(0);
    expect(a!.ratio).toBe(0); // 0/.. → improving
    expect(a!.trend).toBe("improving");
  });

  it("flags a player who improves LESS than the team (team-relative)", () => {
    // Team of 3: two improve a lot (ratio ~0.25), one barely (ratio ~1.0).
    const good = pulls(20, new Set([0, 1, 2, 3])); // dies early, clean late → ratio 0
    const m = new Map<string, LearnPull[]>([
      ["good1", good],
      ["good2", pulls(20, new Set([0, 1, 2, 3, 4]))],
      // laggard: dies evenly throughout → ratio ~1, well above team median
      ["lag", pulls(20, new Set([0, 2, 4, 6, 11, 13, 15, 17]))],
    ]);
    const res = computeLearning(m);
    const lag = res.find((r) => r.characterId === "lag")!;
    const g1 = res.find((r) => r.characterId === "good1")!;
    expect(g1.flagged).toBe(false);
    expect(lag.relativeRatio).not.toBeNull();
    expect(lag.relativeRatio!).toBeGreaterThan(1.3);
    expect(lag.flagged).toBe(true);
  });

  it("does not flag when the player no longer dies late, even if team-relative is high", () => {
    const m = new Map<string, LearnPull[]>([
      ["a", pulls(16, new Set([0, 1, 2, 3, 4, 5]))], // big improver
      ["b", pulls(16, new Set([0, 1, 2, 3, 4]))],
      ["c", pulls(16, new Set([0, 1]))], // few deaths, clean late
    ]);
    const c = computeLearning(m).find((r) => r.characterId === "c")!;
    expect(c.lateDeathRate).toBe(0);
    expect(c.flagged).toBe(false); // lateDeathRate 0 → never a coaching flag
  });

  it("does not flag a below-team-rate player even when their ratio is high", () => {
    // X barely improves (ratio ~1) but dies early LESS than the heavy team.
    const X = [...pulls(6, new Set([1])), ...pulls(6, new Set([1]))]; // .17 → .17
    const heavy = [...pulls(6, new Set([0, 1, 2, 3])), ...pulls(6, new Set([0, 1]))]; // .67 → .33
    const res = computeLearning(new Map([["X", X], ["Y", heavy], ["Z", heavy]]));
    const x = res.find((r) => r.characterId === "X")!;
    expect(x.relativeRatio!).toBeGreaterThan(1.3); // improved relatively less
    expect(x.flagged).toBe(false); // …but is below the team's late rate
  });

  it("tracks survival time and avoidable-damage enrichment per half", () => {
    const enriched: LearnPull[] = [
      ...Array.from({ length: 6 }, () => ({ died: true, msIntoPull: 30000, avoidableDamage: 1000 })),
      ...Array.from({ length: 6 }, () => ({ died: true, msIntoPull: 90000, avoidableDamage: 200 })),
    ];
    const [a] = computeLearning(new Map([["A", enriched]]));
    expect(a!.earlySurvivalMs).toBe(30000);
    expect(a!.lateSurvivalMs).toBe(90000); // surviving longer = progressing deeper
    expect(a!.earlyAvoidable).toBeCloseTo(1000);
    expect(a!.lateAvoidable).toBeCloseTo(200); // less avoidable dmg late = learning
  });

  it("leaves avoidable null when no meter data is present", () => {
    const [a] = computeLearning(new Map([["A", pulls(12, new Set([0]))]]));
    expect(a!.earlyAvoidable).toBeNull();
    expect(a!.lateAvoidable).toBeNull();
  });
});
