import { describe, expect, it } from "vitest";

import {
  CURRENT_PROFESSION_EXPANSION,
  deriveProfessions,
  extractCurrentTierKnown,
  groupKnownAlphabetical,
  groupKnownLikeInGame,
  isMaxed,
  normalizeName,
  pivotPrimariesByProfession,
  type KnownRecipe,
  type RecipeCategory,
} from "./professions-logic";

// Shapes taken verbatim from a live /professions probe (Ravagunn-illidan etc.).
const blacksmithing = {
  profession: { id: 164, name: "Blacksmithing" },
  // NOTE: no profession-level skill_points (tiered professions omit it).
  tiers: [
    { tier: { id: 2872, name: "Khaz Algar Blacksmithing" }, skill_points: 100, max_skill_points: 100, known_recipes: Array(68).fill({}) },
    { tier: { id: 2907, name: "Midnight Blacksmithing" }, skill_points: 66, max_skill_points: 100, known_recipes: Array(48).fill({}) },
  ],
};
const fishing = {
  profession: { id: 356, name: "Fishing" },
  tiers: [
    { tier: { id: 2876, name: "Khaz Algar Fishing" }, skill_points: 75, max_skill_points: 300, known_recipes: Array(12).fill({}) },
    { tier: { id: 2911, name: "Midnight Fishing" }, skill_points: 27, max_skill_points: 300, known_recipes: Array(12).fill({}) },
  ],
};
// Has the profession but has NOT leveled the current (Midnight) tier:
const tailoringNoMidnight = {
  profession: { id: 197, name: "Tailoring" },
  tiers: [
    { tier: { id: 2823, name: "Dragon Isles Tailoring" }, skill_points: 100, max_skill_points: 100, known_recipes: Array(40).fill({}) },
    { tier: { id: 2882, name: "Khaz Algar Tailoring" }, skill_points: 100, max_skill_points: 100, known_recipes: Array(50).fill({}) },
  ],
};
// Legacy non-tiered profession — skill at the PROFESSION level, tiers empty.
const archaeology = {
  profession: { id: 794, name: "Archaeology" },
  skill_points: 800,
  max_skill_points: 800,
  tiers: [],
};

describe("normalizeName", () => {
  it("handles plain strings and locale objects", () => {
    expect(normalizeName("Blacksmithing")).toBe("Blacksmithing");
    expect(normalizeName({ en_US: "Alchemy", de_DE: "Alchemie" })).toBe("Alchemy");
    expect(normalizeName({ fr_FR: "Couture" })).toBe("Couture"); // no en_US → first
    expect(normalizeName(undefined)).toBe("");
  });
});

describe("deriveProfessions — current-tier resolution", () => {
  it("resolves the current (Midnight) tier, reading skill + recipe count from THAT tier", () => {
    const d = deriveProfessions({ primaries: [blacksmithing], secondaries: [] });
    expect(d.primaries).toHaveLength(1);
    const bs = d.primaries[0]!;
    expect(bs.name).toBe("Blacksmithing");
    expect(bs.kind).toBe("primary");
    expect(bs.current).toEqual({
      tierName: "Midnight Blacksmithing",
      skill: 66, // from the Midnight tier, NOT Khaz Algar's 100
      max: 100,
      knownRecipes: 48, // current-tier recipes only (not 68+48)
    });
  });

  it("reads per-profession caps live (Fishing max 300, not 100)", () => {
    const d = deriveProfessions({ primaries: [], secondaries: [fishing] });
    expect(d.secondaries[0]!.current).toMatchObject({ skill: 27, max: 300, knownRecipes: 12 });
  });

  it("a profession WITHOUT a current-expansion tier is 'not leveled' (null), NOT a stale older tier", () => {
    const d = deriveProfessions({ primaries: [tailoringNoMidnight], secondaries: [] });
    expect(d.primaries[0]!.name).toBe("Tailoring");
    expect(d.primaries[0]!.current).toBeNull(); // must NOT show Khaz Algar 100/100
  });

  it("legacy non-tiered profession (Archaeology) falls back to profession-level skill", () => {
    const d = deriveProfessions({ primaries: [], secondaries: [archaeology] });
    expect(d.secondaries[0]!.current).toEqual({
      tierName: "Archaeology",
      skill: 800,
      max: 800,
      knownRecipes: 0,
    });
  });

  it("omitted primaries/secondaries → empty arrays (character with no professions)", () => {
    expect(deriveProfessions({})).toEqual({ primaries: [], secondaries: [] });
    expect(deriveProfessions({ _links: {}, character: {} })).toEqual({ primaries: [], secondaries: [] });
    expect(deriveProfessions(null)).toEqual({ primaries: [], secondaries: [] });
  });

  it("uses the expansion constant (sanity guard on the pinned name)", () => {
    expect(CURRENT_PROFESSION_EXPANSION).toBe("Midnight");
  });
});

describe("isMaxed", () => {
  it("true only when skill >= max > 0", () => {
    expect(isMaxed({ tierName: "x", skill: 100, max: 100, knownRecipes: 0 })).toBe(true);
    expect(isMaxed({ tierName: "x", skill: 66, max: 100, knownRecipes: 0 })).toBe(false);
    expect(isMaxed(null)).toBe(false);
    expect(isMaxed({ tierName: "x", skill: 0, max: 0, knownRecipes: 0 })).toBe(false);
  });
});

describe("pivotPrimariesByProfession (coverage gap)", () => {
  it("lists every standard primary, with gaps (no crafter) preserved", () => {
    const roster = [
      { characterId: "c1", characterName: "Borin", derived: deriveProfessions({ primaries: [blacksmithing] }) },
    ];
    const pivot = pivotPrimariesByProfession(roster);
    expect(pivot).toHaveLength(11); // all standard primaries shown
    const bs = pivot.find((p) => p.profession === "Blacksmithing")!;
    expect(bs.crafters.map((c) => c.characterName)).toEqual(["Borin"]);
    const ench = pivot.find((p) => p.profession === "Enchanting")!;
    expect(ench.crafters).toHaveLength(0); // GAP — nobody has Enchanting
  });

  it("sorts maxed crafters before in-progress", () => {
    const maxedBs = { profession: { id: 164, name: "Blacksmithing" }, tiers: [{ tier: { id: 2907, name: "Midnight Blacksmithing" }, skill_points: 100, max_skill_points: 100, known_recipes: [] }] };
    const roster = [
      { characterId: "lo", characterName: "Lowbie", derived: deriveProfessions({ primaries: [blacksmithing] }) }, // 66/100
      { characterId: "mx", characterName: "Maxed", derived: deriveProfessions({ primaries: [maxedBs] }) }, // 100/100
    ];
    const bs = pivotPrimariesByProfession(roster).find((p) => p.profession === "Blacksmithing")!;
    expect(bs.crafters.map((c) => c.characterName)).toEqual(["Maxed", "Lowbie"]);
  });
});

// Raw /professions shape WITH known recipe id/name (what extractCurrentTierKnown reads).
const rawWithRecipes = {
  primaries: [
    {
      profession: { id: 164, name: "Blacksmithing" },
      tiers: [
        { tier: { id: 2872, name: "Khaz Algar Blacksmithing" }, known_recipes: [{ id: 1, name: "Old Recipe" }] },
        {
          tier: { id: 2907, name: "Midnight Blacksmithing" },
          known_recipes: [
            { id: 52349, name: "Primalforged Heavy Axe" },
            { id: 52356, name: "Blood-Tempered Gauntlets" },
            { id: 99999, name: "Brand New (orphan)" },
          ],
        },
      ],
    },
  ],
  secondaries: [
    { profession: { id: 185, name: "Cooking" }, tiers: [{ tier: { id: 2908, name: "Midnight Cooking" }, known_recipes: [{ id: 700, name: "Feast" }] }] },
  ],
};

describe("extractCurrentTierKnown", () => {
  it("returns each profession's CURRENT-tier known recipes + ids for the game-data fetch", () => {
    const got = extractCurrentTierKnown(rawWithRecipes);
    expect(got).toHaveLength(2);
    const bs = got.find((p) => p.name === "Blacksmithing")!;
    expect(bs).toMatchObject({ profId: 164, kind: "primary", tierId: 2907, tierName: "Midnight Blacksmithing" });
    // Only Midnight-tier recipes (NOT the Khaz Algar "Old Recipe"):
    expect(bs.knownRecipes.map((r) => r.id)).toEqual([52349, 52356, 99999]);
    const cooking = got.find((p) => p.name === "Cooking")!;
    expect(cooking.kind).toBe("secondary");
    expect(cooking.tierId).toBe(2908);
  });
  it("skips a profession with no current-expansion tier", () => {
    const raw = { primaries: [{ profession: { id: 197, name: "Tailoring" }, tiers: [{ tier: { id: 2882, name: "Khaz Algar Tailoring" }, known_recipes: [{ id: 5, name: "x" }] }] }] };
    expect(extractCurrentTierKnown(raw)).toEqual([]);
  });
  it("empty / no professions → []", () => {
    expect(extractCurrentTierKnown(null)).toEqual([]);
    expect(extractCurrentTierKnown({})).toEqual([]);
  });

  it("dedupes a duplicate recipe id in known_recipes (keep first)", () => {
    const raw = {
      primaries: [
        {
          profession: { id: 164, name: "Blacksmithing" },
          tiers: [
            {
              tier: { id: 2907, name: "Midnight Blacksmithing" },
              known_recipes: [
                { id: 5, name: "Sword" },
                { id: 5, name: "Sword (dup)" },
                { id: 6, name: "Axe" },
              ],
            },
          ],
        },
      ],
    };
    const known = extractCurrentTierKnown(raw)[0]!.knownRecipes;
    expect(known.map((r) => r.id)).toEqual([5, 6]); // dup dropped
    expect(known[0]!.name).toBe("Sword"); // first kept
  });
});

describe("groupKnownLikeInGame", () => {
  const known: KnownRecipe[] = [
    { id: 52349, name: "Primalforged Heavy Axe" }, // Weapons
    { id: 52356, name: "Blood-Tempered Gauntlets" }, // Armor
    { id: 99999, name: "Brand New (orphan)" }, // in NO category
  ];
  const categories: RecipeCategory[] = [
    { name: "Recrafting", recipeIds: [51520] }, // nothing known → skipped
    { name: "Weapons", recipeIds: [52349, 52350] },
    { name: "Armor", recipeIds: [52356, 52357] },
  ];

  it("groups known recipes in category order, skips empty categories, buckets orphans into Other", () => {
    const groups = groupKnownLikeInGame(known, categories);
    expect(groups.map((g) => g.category)).toEqual(["Weapons", "Armor", "Other"]);
    expect(groups[0]!.recipes.map((r) => r.id)).toEqual([52349]);
    expect(groups[1]!.recipes.map((r) => r.id)).toEqual([52356]);
    expect(groups[2]!.recipes.map((r) => r.id)).toEqual([99999]); // never dropped
  });

  it("dedupes a cross-listed recipe (first category wins)", () => {
    const cats: RecipeCategory[] = [
      { name: "Weapons", recipeIds: [52349] },
      { name: "Featured", recipeIds: [52349] }, // same id again
    ];
    const groups = groupKnownLikeInGame([{ id: 52349, name: "Axe" }], cats);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.category).toBe("Weapons");
    expect(groups[0]!.recipes).toHaveLength(1);
  });

  it("no orphan bucket when every known recipe is categorized; total is lossless", () => {
    const groups = groupKnownLikeInGame(
      [{ id: 52349, name: "Axe" }, { id: 52356, name: "Gauntlets" }],
      categories,
    );
    expect(groups.map((g) => g.category)).toEqual(["Weapons", "Armor"]);
    const total = groups.reduce((n, g) => n + g.recipes.length, 0);
    expect(total).toBe(2);
  });
});

describe("groupKnownAlphabetical (fallback)", () => {
  it("single 'All recipes' group sorted by name; empty → []", () => {
    const groups = groupKnownAlphabetical([{ id: 2, name: "Banana" }, { id: 1, name: "Apple" }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.recipes.map((r) => r.name)).toEqual(["Apple", "Banana"]);
    expect(groupKnownAlphabetical([])).toEqual([]);
  });
});
