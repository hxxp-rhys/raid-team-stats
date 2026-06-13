import { describe, expect, it } from "vitest";

import {
  buildRoster,
  countsAsPresent,
  parseComp,
  type RosterMember,
} from "./roster";

const mk = (over: Partial<RosterMember>): RosterMember => ({
  userId: "u",
  characterId: "c",
  name: "Char",
  classId: 1,
  role: "DPS",
  state: "NO_RESPONSE",
  etaMinutes: null,
  reason: null,
  selection: null,
  source: null,
  updatedAt: null,
  ...over,
});

describe("countsAsPresent", () => {
  it("confirm and late count; tentative/absent/no-response don't", () => {
    expect(countsAsPresent("CONFIRM")).toBe(true);
    expect(countsAsPresent("LATE")).toBe(true);
    expect(countsAsPresent("TENTATIVE")).toBe(false);
    expect(countsAsPresent("ABSENT")).toBe(false);
    expect(countsAsPresent("NO_RESPONSE")).toBe(false);
  });
});

describe("buildRoster", () => {
  it("groups by role, orders by state, counts present + gaps", () => {
    const members: RosterMember[] = [
      mk({ characterId: "t1", name: "Tankin", role: "TANK", state: "CONFIRM" }),
      mk({ characterId: "t2", name: "Tanktwo", role: "TANK", state: "NO_RESPONSE" }),
      mk({ characterId: "h1", name: "Healer", role: "HEAL", state: "LATE", etaMinutes: 20 }),
      mk({ characterId: "d1", name: "Zeph", role: "DPS", state: "CONFIRM" }),
      mk({ characterId: "d2", name: "Aria", role: "DPS", state: "ABSENT" }),
    ];
    const v = buildRoster(members, { tanks: 2, healers: 2, dps: 1 });

    // present: 1 tank + 1 heal + 1 dps = 3
    expect(v.readiness.present).toBe(3);
    expect(v.readiness.byRole).toEqual({ TANK: 1, HEAL: 1, DPS: 1 });
    expect(v.readiness.total).toBe(5);
    // tanks short by 1, healers short by 1, dps met
    expect(v.readiness.gaps).toEqual({ tanks: 1, healers: 1 });
    expect(v.readiness.met).toBe(false);

    // DPS column ordered CONFIRM (Zeph) before ABSENT (Aria)
    const dps = v.groups.find((g) => g.role === "DPS")!;
    expect(dps.members.map((m) => m.name)).toEqual(["Zeph", "Aria"]);

    expect(v.counts.CONFIRM).toBe(2);
    expect(v.counts.LATE).toBe(1);
    expect(v.counts.ABSENT).toBe(1);
    expect(v.counts.NO_RESPONSE).toBe(1);
  });

  it("folds unknown-role into DPS readiness but keeps a separate bucket", () => {
    const members: RosterMember[] = [
      mk({ characterId: "x", name: "Specless", role: null, state: "CONFIRM" }),
    ];
    const v = buildRoster(members, { tanks: 0, healers: 0, dps: 1 });
    expect(v.unknownRole.map((m) => m.name)).toEqual(["Specless"]);
    expect(v.readiness.byRole.DPS).toBe(1);
    expect(v.readiness.met).toBe(true);
  });

  it("met when comp satisfied", () => {
    const members: RosterMember[] = [
      mk({ characterId: "t", role: "TANK", state: "CONFIRM" }),
      mk({ characterId: "h", role: "HEAL", state: "CONFIRM" }),
    ];
    expect(buildRoster(members, { tanks: 1, healers: 1, dps: 0 }).readiness.met).toBe(
      true,
    );
  });
});

describe("parseComp", () => {
  it("reads valid numbers, falls back per-field, defaults on junk", () => {
    expect(parseComp({ tanks: 3, healers: 4, dps: 13 })).toEqual({
      tanks: 3,
      healers: 4,
      dps: 13,
    });
    expect(parseComp({ tanks: 3 })).toEqual({ tanks: 3, healers: 5, dps: 13 });
    expect(parseComp(null)).toEqual({ tanks: 2, healers: 5, dps: 13 });
    expect(parseComp("nope")).toEqual({ tanks: 2, healers: 5, dps: 13 });
  });
});
