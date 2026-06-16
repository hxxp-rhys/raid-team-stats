import { describe, expect, it } from "vitest";

import {
  aggregateLedger,
  buildIngestDeaths,
  matchRezzesToDeaths,
  parseDeathEvents,
  parseDeathsTable,
  parseRezCasts,
  type LedgerDeath,
  type LedgerFight,
  type RezTarget,
} from "./first-death-ledger";

describe("parseRezCasts", () => {
  it("keeps only landed casts with sourceID as the rezzer", () => {
    const raw = [
      { type: "cast", fight: 4, sourceID: 39, targetID: 17, abilityGameID: 20484, timestamp: 1000 },
      { type: "begincast", fight: 4, sourceID: 39, targetID: 6, abilityGameID: 20484, timestamp: 900 }, // dropped
      { type: "cast", fight: 4, sourceID: -1, targetID: 7, abilityGameID: 61999, timestamp: 2000 },
    ];
    const out = parseRezCasts(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ fightId: 4, targetActorId: 17, rezzerActorId: 39, abilityGameId: 20484, timestamp: 1000 });
    expect(out[1]!.rezzerActorId).toBeNull(); // -1 sentinel
  });
  it("malformed → []", () => {
    expect(parseRezCasts(null)).toEqual([]);
    expect(parseRezCasts([{ type: "cast", fight: 1 }])).toEqual([]); // no target/ts
  });
});

describe("matchRezzesToDeaths", () => {
  const mk = (fightId: number, targetActorId: number, deathAtMs: number): RezTarget => ({
    fightId,
    targetActorId,
    deathAtMs,
    rezzedAtMs: null,
    rezzerActorId: null,
    rezAbilityGameId: null,
  });
  it("stamps each rez onto the most-recent prior death of its target", () => {
    const deaths = [mk(1, 5, 1000), mk(1, 5, 9000)]; // died, rezzed, died again
    matchRezzesToDeaths(deaths, [
      { fightId: 1, targetActorId: 5, absTimeMs: 5000, rezzerActorId: 39, abilityGameId: 20484 },
    ]);
    expect(deaths[0]!.rezzedAtMs).toBe(5000); // the 1000 death was rezzed
    expect(deaths[0]!.rezzerActorId).toBe(39);
    expect(deaths[1]!.rezzedAtMs).toBeNull(); // the later death has no rez after it
  });
  it("doesn't match a rez to a different target or a future death", () => {
    const deaths = [mk(1, 5, 8000), mk(1, 6, 1000)];
    matchRezzesToDeaths(deaths, [
      { fightId: 1, targetActorId: 5, absTimeMs: 2000, rezzerActorId: 1, abilityGameId: 20484 }, // before 5's only death → no match
    ]);
    expect(deaths[0]!.rezzedAtMs).toBeNull();
    expect(deaths[1]!.rezzedAtMs).toBeNull();
  });
});

// Fixtures lifted verbatim from a live WCL probe (report WhwV1qZjym67xTLA).
const EVENTS = [
  { timestamp: 298434, type: "death", sourceID: -1, targetID: 17, abilityGameID: 0, fight: 4, killerID: 39, killingAbilityGameID: 1 },
  { timestamp: 307491, type: "death", sourceID: -1, targetID: 6, abilityGameID: 0, fight: 4, killerID: 39, killingAbilityGameID: 1279890 },
  { timestamp: 1217913, type: "death", sourceID: -1, targetID: 7, abilityGameID: 0, fight: 10, killerID: 151, killingAbilityGameID: 1259921 },
  { timestamp: 1217916, type: "death", sourceID: -1, targetID: 32, abilityGameID: 0, fight: 10, killerID: 151, killingAbilityGameID: 1259921 },
];
const TABLE = {
  data: {
    entries: [
      { name: "Mishri", id: 17, timestamp: 298432, fight: 4, overkill: 162248, killingBlow: { name: "Melee", guid: 1 } },
      { name: "Zooks", id: 6, timestamp: 307491, fight: 4, overkill: 280732, killingBlow: { name: "Void Bolt", guid: 1279890 } },
      { name: "Ravagunn", id: 7, timestamp: 1217913, fight: 10, overkill: 1408397, killingBlow: { name: "Collapse", guid: 1259921 } },
    ],
  },
};

describe("parseDeathEvents", () => {
  it("extracts death rows, mapping killerID/killingAbilityGameID (not abilityGameID)", () => {
    const out = parseDeathEvents(EVENTS);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({
      fightId: 4,
      targetActorId: 17,
      killerActorId: 39,
      killingAbilityGameId: 1,
      timestamp: 298434,
    });
  });
  it("treats environment/none killer sentinels (-1, 0) as no killer", () => {
    const out = parseDeathEvents([
      { type: "death", fight: 1, targetID: 5, timestamp: 100, killerID: -1, killingAbilityGameID: 0 },
      { type: "death", fight: 1, targetID: 6, timestamp: 200, killerID: 0, killingAbilityGameID: 9 },
    ]);
    expect(out[0]!.killerActorId).toBeNull();
    expect(out[1]!.killerActorId).toBeNull();
  });
  it("drops non-death rows and malformed entries", () => {
    expect(parseDeathEvents([{ type: "damage", fight: 1, targetID: 5, timestamp: 1 }])).toEqual([]);
    expect(parseDeathEvents([{ type: "death", targetID: 5, timestamp: 1 }])).toEqual([]); // no fight
    expect(parseDeathEvents(null)).toEqual([]);
    expect(parseDeathEvents("nope")).toEqual([]);
  });
});

describe("parseDeathsTable", () => {
  it("pulls overkill + killingBlow name/guid per entry", () => {
    const out = parseDeathsTable(TABLE);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      fightId: 4,
      actorId: 17,
      timestamp: 298432,
      overkill: 162248,
      killingAbilityName: "Melee",
      killingAbilityGameId: 1,
    });
  });
  it("tolerates a missing table / entries", () => {
    expect(parseDeathsTable(null)).toEqual([]);
    expect(parseDeathsTable({})).toEqual([]);
    expect(parseDeathsTable({ data: {} })).toEqual([]);
  });
});

describe("buildIngestDeaths", () => {
  it("assigns 0-based death order per fight and merges the table drill-down", () => {
    const out = buildIngestDeaths(parseDeathEvents(EVENTS), parseDeathsTable(TABLE));
    const f4 = out.filter((d) => d.fightId === 4).sort((a, b) => a.deathOrder - b.deathOrder);
    expect(f4.map((d) => d.deathOrder)).toEqual([0, 1]);
    expect(f4[0]).toMatchObject({
      targetActorId: 17,
      deathOrder: 0,
      overkill: 162248, // matched within tolerance (298434 vs 298432)
      killingAbilityName: "Melee",
    });
    expect(f4[1]).toMatchObject({ targetActorId: 6, deathOrder: 1, killingAbilityName: "Void Bolt" });
    // fight 10 deaths get a fresh order sequence
    const f10 = out.filter((d) => d.fightId === 10).sort((a, b) => a.deathOrder - b.deathOrder);
    expect(f10.map((d) => d.deathOrder)).toEqual([0, 1]);
  });
  it("matches each event to the nearest table row, so a double-death (brez) doesn't collide", () => {
    const events = parseDeathEvents([
      { type: "death", fight: 1, targetID: 5, timestamp: 1000, killingAbilityGameID: 11 },
      { type: "death", fight: 1, targetID: 5, timestamp: 9000, killingAbilityGameID: 22 },
    ]);
    const table = parseDeathsTable({
      data: { entries: [
        { id: 5, fight: 1, timestamp: 1001, overkill: 10, killingBlow: { name: "First", guid: 11 } },
        { id: 5, fight: 1, timestamp: 9001, overkill: 20, killingBlow: { name: "Second", guid: 22 } },
      ] },
    });
    const out = buildIngestDeaths(events, table).sort((a, b) => a.deathOrder - b.deathOrder);
    expect(out[0]).toMatchObject({ deathOrder: 0, overkill: 10, killingAbilityName: "First" });
    expect(out[1]).toMatchObject({ deathOrder: 1, overkill: 20, killingAbilityName: "Second" });
  });
  it("leaves overkill/name null when no table row is within tolerance", () => {
    const events = parseDeathEvents([{ type: "death", fight: 1, targetID: 5, timestamp: 1000, killingAbilityGameID: 11 }]);
    const out = buildIngestDeaths(events, []);
    expect(out[0]).toMatchObject({ overkill: null, killingAbilityName: null, killingAbilityGameId: 11 });
  });
});

describe("aggregateLedger", () => {
  // 6 wipe pulls on encounter 100/diff 5; A present all 6, B present 5.
  const present = ["A", "B"];
  const fights: LedgerFight[] = Array.from({ length: 6 }, (_, i) => ({
    encounterId: 100,
    difficulty: 5,
    kill: false,
    presentCharacterIds: i === 5 ? ["A"] : present, // B missed the 6th
    observed: true,
  }));
  // A dies first on 4 of its pulls; B dies first on 1, early on a couple.
  const deaths: LedgerDeath[] = [
    ...[0, 1, 2, 3].map((i) => ({ encounterId: 100, difficulty: 5, kill: false, characterId: "A", deathOrder: 0, msIntoPull: 30000 + i, killingAbilityName: "Cleave", overkill: 100 })),
    { encounterId: 100, difficulty: 5, kill: false, characterId: "B", deathOrder: 0, msIntoPull: 40000, killingAbilityName: "Bolt", overkill: 50 },
    { encounterId: 100, difficulty: 5, kill: false, characterId: "B", deathOrder: 2, msIntoPull: 41000, killingAbilityName: "Bolt", overkill: 60 },
  ];

  it("computes first/early rates per pulls-present (per 10 pulls) and sorts by first-death", () => {
    const [enc] = aggregateLedger(fights, deaths);
    expect(enc!.encounterId).toBe(100);
    expect(enc!.wipePulls).toBe(6);
    const a = enc!.members.find((m) => m.characterId === "A")!;
    const b = enc!.members.find((m) => m.characterId === "B")!;
    expect(a.pullsPresent).toBe(6);
    expect(a.firstDeaths).toBe(4);
    expect(a.firstDeathRate).toBeCloseTo((4 / 6) * 10); // 6.67 per 10 pulls
    expect(b.pullsPresent).toBe(5);
    expect(b.earlyDeaths).toBe(2); // order 0 and order 2 both ≤ 2
    expect(a.topKillingAbility).toEqual({ name: "Cleave", count: 4 });
    // A (higher first-death rate) sorts ahead of B
    expect(enc!.members[0]!.characterId).toBe("A");
  });

  it("hides encounters under MIN_WIPES and members under MIN_PULLS_PRESENT", () => {
    expect(aggregateLedger(fights.slice(0, 4), deaths)).toEqual([]); // only 4 wipes
    // member present for only 4 wipes is dropped
    const thin: LedgerFight[] = fights.map((f, i) => ({ ...f, presentCharacterIds: i < 4 ? ["A", "C"] : ["A"] }));
    const [enc] = aggregateLedger(thin, deaths);
    expect(enc!.members.find((m) => m.characterId === "C")).toBeUndefined();
    expect(enc!.members.find((m) => m.characterId === "A")).toBeDefined();
  });

  it("keeps kill-pull deaths separate from the wipe metric", () => {
    const withKill: LedgerDeath[] = [
      ...deaths,
      { encounterId: 100, difficulty: 5, kill: true, characterId: "A", deathOrder: 0, msIntoPull: 5000, killingAbilityName: "X", overkill: null },
    ];
    const killFights: LedgerFight[] = [
      ...fights,
      { encounterId: 100, difficulty: 5, kill: true, presentCharacterIds: ["A", "B"], observed: true },
    ];
    const [enc] = aggregateLedger(killFights, withKill);
    const a = enc!.members.find((m) => m.characterId === "A")!;
    expect(a.deaths).toBe(4); // wipe deaths only
    expect(a.killDeaths).toBe(1); // counted separately
    expect(enc!.killPulls).toBe(1);
  });

  it("excludes UNOBSERVED wipes (no death layer) from the rate denominator", () => {
    // 6 observed wipes + 4 unobserved (backfill still in flight). A present in
    // all 10; rates must be over the 6 observed pulls, not all 10.
    const mixed: LedgerFight[] = [
      ...fights, // 6 observed (A present in all 6)
      ...Array.from({ length: 4 }, () => ({
        encounterId: 100,
        difficulty: 5,
        kill: false,
        presentCharacterIds: ["A", "B"],
        observed: false,
      })),
    ];
    const [enc] = aggregateLedger(mixed, deaths);
    expect(enc!.wipePulls).toBe(10);
    expect(enc!.observedWipePulls).toBe(6);
    const a = enc!.members.find((m) => m.characterId === "A")!;
    expect(a.pullsPresent).toBe(6); // not 10
    expect(a.firstDeathRate).toBeCloseTo((4 / 6) * 10);
  });

  it("hides an encounter when too few wipes are observed even if many exist", () => {
    const fewObserved: LedgerFight[] = fights.map((f, i) => ({
      ...f,
      observed: i < 3, // only 3 observed < MIN_WIPES
    }));
    expect(aggregateLedger(fewObserved, deaths)).toEqual([]);
  });

  it("ignores unmatched (null character) deaths in per-member rates", () => {
    const withNull: LedgerDeath[] = [
      ...deaths,
      { encounterId: 100, difficulty: 5, kill: false, characterId: null, deathOrder: 0, msIntoPull: 1, killingAbilityName: null, overkill: null },
    ];
    const [enc] = aggregateLedger(fights, withNull);
    // total first-death tally unaffected by the unmatched death
    const a = enc!.members.find((m) => m.characterId === "A")!;
    expect(a.firstDeaths).toBe(4);
  });
});
