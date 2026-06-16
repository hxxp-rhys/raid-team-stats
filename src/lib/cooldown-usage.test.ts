import { describe, expect, it } from "vitest";

import {
  aggregateCooldownUsage,
  computeCooldownUsage,
  parseBuffEvents,
  parseDefensiveCasts,
  type CooldownDeathInput,
  type DeathForCooldown,
} from "./cooldown-usage";

const death = (o: Partial<CooldownDeathInput>): CooldownDeathInput => ({
  encounterId: 1,
  difficulty: 5,
  kill: false,
  characterId: "c1",
  killingAbilityGameId: 100,
  killingAbilityName: "Frost Nova",
  defensiveActiveGameId: null,
  lastDefensiveCastMsBefore: null,
  computed: true,
  ...o,
});

// 871 = Shield Wall (personal), 48707 = Anti-Magic Shell (personal),
// 33206 = Pain Suppression (EXTERNAL — must be ignored by the personal scan).

describe("parseBuffEvents", () => {
  it("maps apply/refresh→on and remove→off, drops other types", () => {
    const raw = [
      { type: "applybuff", fight: 1, sourceID: 64, targetID: 64, abilityGameID: 871, timestamp: 1000 },
      { type: "refreshbuff", fight: 1, sourceID: 64, targetID: 64, abilityGameID: 871, timestamp: 1500 },
      { type: "removebuff", fight: 1, sourceID: 64, targetID: 64, abilityGameID: 871, timestamp: 9000 },
      { type: "applydebuff", fight: 1, sourceID: 5, targetID: 64, abilityGameID: 123, timestamp: 1200 }, // dropped
    ];
    const out = parseBuffEvents(raw);
    expect(out.map((e) => e.state)).toEqual(["on", "on", "off"]);
    expect(out[0]).toMatchObject({
      sourceActorId: 64,
      targetActorId: 64,
      abilityGameId: 871,
      fightId: 1,
    });
  });

  it("tolerates junk and missing fields without throwing", () => {
    expect(parseBuffEvents(null)).toEqual([]);
    expect(parseBuffEvents([{ type: "applybuff" }])).toEqual([]);
  });
});

describe("parseDefensiveCasts", () => {
  it("keeps only landed casts with a positive source", () => {
    const raw = [
      { type: "cast", fight: 2, sourceID: 64, targetID: -1, abilityGameID: 871, timestamp: 500 },
      { type: "begincast", fight: 2, sourceID: 64, targetID: -1, abilityGameID: 871, timestamp: 400 }, // dropped
      { type: "cast", fight: 2, sourceID: -1, targetID: -1, abilityGameID: 871, timestamp: 600 }, // bad source
    ];
    const out = parseDefensiveCasts(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sourceActorId: 64, abilityGameId: 871, fightId: 2 });
  });
});

describe("computeCooldownUsage", () => {
  const deaths: DeathForCooldown[] = [
    { fightId: 1, targetActorId: 64, relMs: 5000 }, // during Shield Wall window
    { fightId: 1, targetActorId: 64, relMs: 12000 }, // after it dropped
  ];

  it("flags a personal defensive active at death and clears it once removed", () => {
    const buffs = parseBuffEvents([
      { type: "applybuff", fight: 1, sourceID: 64, targetID: 64, abilityGameID: 871, timestamp: 1000 },
      { type: "removebuff", fight: 1, sourceID: 64, targetID: 64, abilityGameID: 871, timestamp: 9000 },
    ]);
    const out = computeCooldownUsage(deaths, buffs, []);
    expect(out[0].defensiveActiveGameId).toBe(871);
    expect(out[0].defensiveActiveName).toBe("Shield Wall");
    expect(out[1].defensiveActiveGameId).toBeNull(); // dropped before the 2nd death
  });

  it("reports the most-recently-applied defensive when several are active", () => {
    const buffs = parseBuffEvents([
      { type: "applybuff", fight: 1, sourceID: 64, targetID: 64, abilityGameID: 871, timestamp: 1000 },
      { type: "applybuff", fight: 1, sourceID: 64, targetID: 64, abilityGameID: 48707, timestamp: 4000 },
    ]);
    const out = computeCooldownUsage([deaths[0]], buffs, []);
    expect(out[0].defensiveActiveGameId).toBe(48707); // applied at 4000 > 1000
  });

  it("ignores EXTERNAL defensives and buffs cast by someone else", () => {
    const buffs = parseBuffEvents([
      // Pain Suppression on the dying player from a healer — external, ignored
      { type: "applybuff", fight: 1, sourceID: 30, targetID: 64, abilityGameID: 33206, timestamp: 1000 },
      // Shield Wall but "sourced" by another actor (odd attribution) — ignored
      { type: "applybuff", fight: 1, sourceID: 99, targetID: 64, abilityGameID: 871, timestamp: 1000 },
    ]);
    const out = computeCooldownUsage([deaths[0]], buffs, []);
    expect(out[0].defensiveActiveGameId).toBeNull();
  });

  it("captures the most-recent personal cast before death with ms-before", () => {
    const casts = parseDefensiveCasts([
      { type: "cast", fight: 1, sourceID: 64, targetID: -1, abilityGameID: 871, timestamp: 2000 },
      { type: "cast", fight: 1, sourceID: 64, targetID: -1, abilityGameID: 48707, timestamp: 4500 },
      { type: "cast", fight: 1, sourceID: 64, targetID: -1, abilityGameID: 871, timestamp: 8000 }, // after death (5000)
    ]);
    const out = computeCooldownUsage([deaths[0]], [], casts);
    expect(out[0].lastDefensiveCastId).toBe(48707);
    expect(out[0].lastDefensiveCastMsBefore).toBe(500); // 5000 - 4500
  });

  it("returns null signals when the player did nothing", () => {
    const out = computeCooldownUsage([deaths[0]], [], []);
    expect(out[0]).toEqual({
      defensiveActiveGameId: null,
      defensiveActiveName: null,
      lastDefensiveCastId: null,
      lastDefensiveCastMsBefore: null,
    });
  });

  it("keeps results index-aligned with the input deaths", () => {
    const buffs = parseBuffEvents([
      { type: "applybuff", fight: 1, sourceID: 64, targetID: 64, abilityGameID: 871, timestamp: 1000 },
      { type: "removebuff", fight: 1, sourceID: 64, targetID: 64, abilityGameID: 871, timestamp: 9000 },
    ]);
    const out = computeCooldownUsage(deaths, buffs, []);
    expect(out).toHaveLength(2);
  });
});

describe("aggregateCooldownUsage", () => {
  it("computes coverage and excludes kills + uncomputed rows", () => {
    const rows = [
      death({ defensiveActiveGameId: 871 }), // covered
      death({ defensiveActiveGameId: null }), // uncovered
      death({ kill: true, defensiveActiveGameId: null }), // kill — excluded
      death({ computed: false, defensiveActiveGameId: null }), // not computed — excluded
    ];
    const [agg] = aggregateCooldownUsage(rows);
    expect(agg.deaths).toBe(2);
    expect(agg.covered).toBe(1);
    expect(agg.uncovered).toBe(1);
    expect(agg.coveragePct).toBe(50);
  });

  it("builds a per-player table sorted by uncovered, flagging pressed-late", () => {
    const rows = [
      death({ characterId: "slacker", defensiveActiveGameId: null, lastDefensiveCastMsBefore: null }),
      death({ characterId: "slacker", defensiveActiveGameId: null, lastDefensiveCastMsBefore: 2000 }), // pressed late
      death({ characterId: "pro", defensiveActiveGameId: 871 }),
    ];
    const [agg] = aggregateCooldownUsage(rows);
    expect(agg.players[0].characterId).toBe("slacker");
    expect(agg.players[0].uncovered).toBe(2);
    expect(agg.players[0].pressedLate).toBe(1);
    expect(agg.players[1].characterId).toBe("pro");
    expect(agg.players[1].coveragePct).toBe(100);
  });

  it("groups mechanics by killing ability, sorted by uncovered", () => {
    const rows = [
      death({ killingAbilityGameId: 100, killingAbilityName: "Frost Nova", defensiveActiveGameId: null }),
      death({ killingAbilityGameId: 100, killingAbilityName: "Frost Nova", defensiveActiveGameId: null }),
      death({ killingAbilityGameId: 200, killingAbilityName: "Cleave", defensiveActiveGameId: 871 }),
    ];
    const [agg] = aggregateCooldownUsage(rows);
    expect(agg.mechanics[0].name).toBe("Frost Nova");
    expect(agg.mechanics[0].uncovered).toBe(2);
  });

  it("separates difficulties, sorted high→low", () => {
    const rows = [
      death({ difficulty: 4 }),
      death({ difficulty: 5 }),
      death({ difficulty: 5 }),
    ];
    const aggs = aggregateCooldownUsage(rows);
    expect(aggs.map((a) => a.difficulty)).toEqual([5, 4]);
    expect(aggs[0].deaths).toBe(2);
  });
});
