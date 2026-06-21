import { describe, expect, it } from "vitest";

import {
  deriveTargetArrays,
  leadingZoneIds,
  parseRaidTargetOrder,
  type RaidTargetItem,
} from "./raid-target";

const zone = (id: number): RaidTargetItem => ({ type: "zone", id, zoneId: id });
const boss = (id: number, zoneId: number): RaidTargetItem => ({
  type: "encounter",
  id,
  zoneId,
});

describe("deriveTargetArrays", () => {
  it("distinct zoneIds in first-seen order; encounter ids in order", () => {
    const order = [boss(11, 1), boss(12, 1), zone(2), boss(31, 3)];
    expect(deriveTargetArrays(order)).toEqual({
      targetZoneIds: [1, 2, 3],
      targetEncounterIds: [11, 12, 31],
    });
  });

  it("a whole-zone entry contributes its zone, no encounter", () => {
    expect(deriveTargetArrays([zone(5)])).toEqual({
      targetZoneIds: [5],
      targetEncounterIds: [],
    });
  });

  it("same zone as both whole-zone and boss entries → zone listed once", () => {
    expect(deriveTargetArrays([zone(1), boss(11, 1)])).toEqual({
      targetZoneIds: [1],
      targetEncounterIds: [11],
    });
  });

  it("3+ distinct zones (no 2-cap regression)", () => {
    expect(deriveTargetArrays([zone(1), zone(2), zone(3)]).targetZoneIds).toEqual([
      1, 2, 3,
    ]);
  });
});

describe("leadingZoneIds", () => {
  it("first two entries' zones, deduped (different zones → 2 tiles)", () => {
    expect(leadingZoneIds([zone(1), zone(2), zone(3)])).toEqual([1, 2]);
  });

  it("first two entries of the same zone → one tile", () => {
    expect(leadingZoneIds([boss(11, 1), boss(12, 1), zone(2)])).toEqual([1]);
  });

  it("empty → []", () => {
    expect(leadingZoneIds([])).toEqual([]);
  });
});

describe("parseRaidTargetOrder", () => {
  it("passes valid entries through unchanged", () => {
    const ok = [{ type: "zone", id: 1, zoneId: 1 }];
    expect(parseRaidTargetOrder(ok)).toEqual(ok);
  });

  it("returns [] for null / non-array / wrong-shape JSON", () => {
    expect(parseRaidTargetOrder(null)).toEqual([]);
    expect(parseRaidTargetOrder("garbage")).toEqual([]);
    expect(parseRaidTargetOrder([{ type: "boss", id: 1, zoneId: 1 }])).toEqual([]);
    expect(parseRaidTargetOrder([{ type: "zone", id: "x", zoneId: 1 }])).toEqual([]);
  });
});
