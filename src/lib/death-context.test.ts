import { describe, expect, it } from "vitest";

import {
  buildDeathContext,
  parseBuffString,
  parseCastWindow,
  parseDamageTakenEvents,
} from "./death-context";

// 871 = Shield Wall (personal), 33206 = Pain Suppression (external).

describe("parseBuffString", () => {
  it("splits the dotted buff list into positive ids", () => {
    expect(parseBuffString("871.33206.99999.")).toEqual([871, 33206, 99999]);
    expect(parseBuffString("")).toEqual([]);
    expect(parseBuffString(null)).toEqual([]);
  });
});

describe("parseDamageTakenEvents", () => {
  it("keeps damage rows with amounts + parsed buffs", () => {
    const out = parseDamageTakenEvents([
      { type: "damage", timestamp: 1000, abilityGameID: 50, amount: 8000, unmitigatedAmount: 30000, overkill: 0, buffs: "871." },
      { type: "begincast", timestamp: 900 }, // ignored
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ms: 1000, abilityId: 50, amount: 8000, buffs: [871] });
  });
});

describe("buildDeathContext", () => {
  const names = new Map<number, string>([[50, "Frost Nova"], [99, "Cleave"]]);

  it("marks the fatal hit, reads active defensives from its buffs, and flags personal coverage", () => {
    const damage = parseDamageTakenEvents([
      { type: "damage", timestamp: 4000, abilityGameID: 99, amount: 1000, buffs: "" },
      { type: "damage", timestamp: 5000, abilityGameID: 50, amount: 90000, overkill: 40000, buffs: "871.33206." },
    ]);
    const ctx = buildDeathContext(5000, damage, [], [], names, {
      windowMs: 10000,
      killingAbilityId: 50,
      killingAbilityName: "Frost Nova",
    });
    expect(ctx.fatal?.abilityName).toBe("Frost Nova");
    expect(ctx.fatal?.overkill).toBe(40000);
    expect(ctx.fatal?.hadPersonalDefensive).toBe(true); // Shield Wall (personal)
    expect(ctx.activeDefensives.map((d) => d.abilityId).sort((a, b) => a - b)).toEqual([871, 33206]);
    expect(ctx.incoming.find((h) => h.fatal)?.abilityId).toBe(50);
    expect(ctx.incoming).toHaveLength(2);
  });

  it("flags no personal defensive when only an external one was up", () => {
    const damage = parseDamageTakenEvents([
      { type: "damage", timestamp: 5000, abilityGameID: 50, amount: 90000, overkill: 1, buffs: "33206." },
    ]);
    const ctx = buildDeathContext(5000, damage, [], [], names, { windowMs: 10000 });
    expect(ctx.fatal?.hadPersonalDefensive).toBe(false);
    expect(ctx.activeDefensives[0]?.kind).toBe("external");
  });

  it("falls back to the last DAMAGING hit when there's no overkill or known killing ability", () => {
    const damage = parseDamageTakenEvents([
      { type: "damage", timestamp: 3000, abilityGameID: 99, amount: 50000, buffs: "" },
      { type: "damage", timestamp: 4000, abilityGameID: 50, amount: 80000, buffs: "" }, // real killing blow
      { type: "damage", timestamp: 4900, abilityGameID: 99, amount: 0, absorbed: 20000, buffs: "" }, // absorbed trailing tick
    ]);
    const ctx = buildDeathContext(5000, damage, [], [], names, { windowMs: 10000 });
    // not the absorbed 0-damage tick at 4900, and not the earlier 50k hit
    expect(ctx.fatal?.abilityId).toBe(50);
    expect(ctx.fatal?.amount).toBe(80000);
    expect(ctx.incoming.find((h) => h.fatal)?.abilityId).toBe(50);
  });

  it("captures the player's defensive casts before death", () => {
    const casts = parseCastWindow([
      { type: "cast", timestamp: 3000, abilityGameID: 871 }, // Shield Wall 2s before
      { type: "cast", timestamp: 3500, abilityGameID: 12345 }, // not a defensive
    ]);
    const ctx = buildDeathContext(5000, [], casts, [], names, { windowMs: 10000 });
    expect(ctx.defensiveCasts).toHaveLength(1);
    expect(ctx.defensiveCasts[0]).toMatchObject({ abilityId: 871, msBeforeDeath: 2000, landed: true });
  });
});
