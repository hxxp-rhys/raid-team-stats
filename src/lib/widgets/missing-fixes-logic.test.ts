import { describe, expect, it } from "vitest";

import {
  formatSlots,
  selectMissing,
  sortByWorst,
  type MissingRow,
} from "./missing-fixes-logic";

const row = (over: Partial<MissingRow>): MissingRow => ({
  characterId: "c",
  name: "X",
  classId: 1,
  missingEnchants: 0,
  missingGems: 0,
  enchSlots: [],
  gemSlots: [],
  ilvl: 600,
  hasEquip: true,
  ...over,
});

describe("formatSlots", () => {
  it("joins unique slots in order", () => {
    expect(formatSlots(["Head", "Shoulder"])).toBe("Head, Shoulder");
  });
  it("collapses repeats into ×N, preserving first-seen order", () => {
    expect(formatSlots(["Ring 1", "Ring 1", "Neck"])).toBe("Ring 1 ×2, Neck");
  });
  it("empty → empty string", () => {
    expect(formatSlots([])).toBe("");
  });
});

describe("sortByWorst", () => {
  it("most-missing first, then iLvL desc", () => {
    const rows = [
      row({ name: "A", missingEnchants: 1, ilvl: 600 }),
      row({ name: "B", missingEnchants: 2, missingGems: 1, ilvl: 590 }),
      row({ name: "C", missingEnchants: 0, ilvl: 700 }),
      row({ name: "D", missingEnchants: 1, ilvl: 650 }),
    ];
    expect([...rows].sort(sortByWorst).map((r) => r.name)).toEqual([
      "B", // 3 missing
      "D", // 1 missing, ilvl 650
      "A", // 1 missing, ilvl 600
      "C", // 0 missing
    ]);
  });
});

describe("selectMissing", () => {
  it("keeps only rows with equipment AND a non-zero deficit, preserving order", () => {
    const rows = [
      row({ name: "B", missingEnchants: 2, missingGems: 1 }),
      row({ name: "D", missingEnchants: 1 }),
      row({ name: "C", missingEnchants: 0, missingGems: 0 }), // fully ready → dropped
      row({ name: "Gemmed", missingGems: 1 }),
    ];
    expect(selectMissing(rows).map((r) => r.name)).toEqual(["B", "D", "Gemmed"]);
  });
  it("excludes characters with no equipment even if counts look non-zero", () => {
    expect(
      selectMissing([row({ name: "NoGear", hasEquip: false, missingEnchants: 3 })]),
    ).toEqual([]);
  });
  it("empty roster → empty list", () => {
    expect(selectMissing([])).toEqual([]);
  });
});
