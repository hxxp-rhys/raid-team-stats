/**
 * WoW reference data shared across widgets. Kept minimal — anything that
 * changes between expansions should live in a snapshot, not here.
 */

export const WOW_CLASS_NAMES: Readonly<Record<number, string>> = {
  1: "Warrior",
  2: "Paladin",
  3: "Hunter",
  4: "Rogue",
  5: "Priest",
  6: "Death Knight",
  7: "Shaman",
  8: "Mage",
  9: "Warlock",
  10: "Monk",
  11: "Druid",
  12: "Demon Hunter",
  13: "Evoker",
};

export const WOW_CLASS_COLORS: Readonly<Record<number, string>> = {
  1: "#C79C6E", // Warrior
  2: "#F58CBA", // Paladin
  3: "#ABD473", // Hunter
  4: "#FFF569", // Rogue
  5: "#FFFFFF", // Priest
  6: "#C41F3B", // Death Knight
  7: "#0070DE", // Shaman
  8: "#69CCF0", // Mage
  9: "#9482C9", // Warlock
  10: "#00FF96", // Monk
  11: "#FF7D0A", // Druid
  12: "#A330C9", // Demon Hunter
  13: "#33937F", // Evoker
};

export const wowClassName = (id: number | null | undefined): string =>
  (id && WOW_CLASS_NAMES[id]) || "Unknown";

export const wowClassColor = (id: number | null | undefined): string =>
  (id && WOW_CLASS_COLORS[id]) || "#808080";

/**
 * Tank / Healer / DPS bucket from class+spec. Spec-aware classes (Druid,
 * Paladin, Shaman, etc.) need the spec name; otherwise classId alone is enough.
 * Returns null when the role can't be determined.
 */
const TANK_SPECS = new Set([
  "Protection", // Paladin, Warrior
  "Guardian", // Druid
  "Blood", // Death Knight
  "Brewmaster", // Monk
  "Vengeance", // Demon Hunter
]);
const HEAL_SPECS = new Set([
  "Holy", // Paladin, Priest
  "Discipline", // Priest
  "Restoration", // Druid, Shaman
  "Mistweaver", // Monk
  "Preservation", // Evoker
]);

export type WowRole = "TANK" | "HEAL" | "DPS";

export const inferRole = (
  classId: number | null | undefined,
  specName: string | null | undefined,
): WowRole | null => {
  if (specName) {
    if (TANK_SPECS.has(specName)) return "TANK";
    if (HEAL_SPECS.has(specName)) return "HEAL";
    return "DPS";
  }
  // Pure-DPS classes — can infer without spec.
  if (classId === 3 || classId === 4 || classId === 8 || classId === 9) {
    return "DPS";
  }
  return null;
};
