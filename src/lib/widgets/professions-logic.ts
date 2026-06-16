/**
 * Pure professions derivation + display helpers. Client-safe (no server/zod
 * imports) so the widget can reuse the types, and unit-testable independently
 * of live data. `deriveProfessions` runs at INGESTION time; the compact result
 * is what the widget renders.
 *
 * Accuracy rules established from a live /professions probe (see
 * docs/widget-build-deliberations.md §D1a):
 *  - "current tier" is the CURRENT-EXPANSION tier, matched by name prefix — NOT
 *    the max tier id (which would surface a stale older-expansion "maxed" number
 *    for a character who hasn't leveled this expansion's tier).
 *  - skill lives on the tier; the profession-level skill is present only for
 *    legacy non-tiered professions (Archaeology), used as a fallback.
 *  - `primaries`/`secondaries` are omitted entirely when a character has none.
 *  - recipe count is per-tier; count within the resolved current tier only.
 */

// Bump each expansion (same maintenance model as the season/zone pins).
export const CURRENT_PROFESSION_EXPANSION = "Midnight";

// The 11 standard primary professions — used to surface coverage GAPS (a
// profession no team crafter has). Stable list; bump only if WoW adds one.
export const PRIMARY_PROFESSIONS = [
  "Alchemy",
  "Blacksmithing",
  "Enchanting",
  "Engineering",
  "Herbalism",
  "Inscription",
  "Jewelcrafting",
  "Leatherworking",
  "Mining",
  "Skinning",
  "Tailoring",
] as const;

export type ProfTierInfo = {
  /** Current-expansion tier name, e.g. "Midnight Blacksmithing". */
  tierName: string;
  skill: number;
  max: number;
  knownRecipes: number;
};

export type ProfEntry = {
  id: number;
  name: string;
  kind: "primary" | "secondary";
  /** Current-expansion tier, or null when not leveled this expansion. */
  current: ProfTierInfo | null;
};

export type DerivedProfessions = {
  primaries: ProfEntry[];
  secondaries: ProfEntry[];
};

/** Localized name → string. Blizzard returns either a plain (en_US) string or a
 *  locale-keyed object; tolerate both. */
export function normalizeName(n: unknown): string {
  if (typeof n === "string") return n;
  if (n && typeof n === "object") {
    const o = n as Record<string, unknown>;
    const v = o.en_US ?? Object.values(o)[0];
    return typeof v === "string" ? v : "";
  }
  return "";
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

type RawTier = {
  tier?: { id?: number; name?: unknown };
  skill_points?: number;
  max_skill_points?: number;
  known_recipes?: unknown[];
};
type RawProf = {
  profession?: { id?: number; name?: unknown };
  skill_points?: number;
  max_skill_points?: number;
  tiers?: RawTier[];
};

function entryOf(p: RawProf, kind: "primary" | "secondary"): ProfEntry {
  const name = normalizeName(p.profession?.name);
  const id = num(p.profession?.id);
  const tiers = Array.isArray(p.tiers) ? p.tiers : [];

  // Current-expansion tier: the one whose name starts with the expansion name.
  const cur = tiers.find((t) =>
    normalizeName(t.tier?.name).startsWith(CURRENT_PROFESSION_EXPANSION),
  );

  let current: ProfTierInfo | null = null;
  if (cur) {
    current = {
      tierName: normalizeName(cur.tier?.name),
      skill: num(cur.skill_points),
      max: num(cur.max_skill_points),
      knownRecipes: Array.isArray(cur.known_recipes) ? cur.known_recipes.length : 0,
    };
  } else if (tiers.length === 0 && typeof p.skill_points === "number") {
    // Legacy non-tiered profession (e.g. Archaeology) → profession-level skill.
    current = {
      tierName: name,
      skill: num(p.skill_points),
      max: num(p.max_skill_points),
      knownRecipes: 0,
    };
  }
  // else: has the profession but no current-expansion tier → "not leveled".

  return { id, name, kind, current };
}

/** Map a validated /professions payload to the compact derived shape. */
export function deriveProfessions(raw: unknown): DerivedProfessions {
  const r = (raw ?? {}) as { primaries?: RawProf[]; secondaries?: RawProf[] };
  return {
    primaries: (Array.isArray(r.primaries) ? r.primaries : []).map((p) =>
      entryOf(p, "primary"),
    ),
    secondaries: (Array.isArray(r.secondaries) ? r.secondaries : []).map((p) =>
      entryOf(p, "secondary"),
    ),
  };
}

/** True when the current-expansion tier is at its cap (can craft top-tier work). */
export function isMaxed(t: ProfTierInfo | null): boolean {
  return t != null && t.max > 0 && t.skill >= t.max;
}

export type Crafter = { characterId: string; characterName: string; entry: ProfEntry };

/**
 * Pivot a roster of derived professions by PRIMARY profession name. Every
 * standard primary profession appears (even with zero crafters) so the coverage
 * GAP — professions nobody on the team has — is visible. Secondaries excluded
 * (they're shown in the per-character view).
 */
export function pivotPrimariesByProfession(
  roster: { characterId: string; characterName: string; derived: DerivedProfessions }[],
): { profession: string; crafters: Crafter[] }[] {
  const byProf = new Map<string, Crafter[]>();
  for (const name of PRIMARY_PROFESSIONS) byProf.set(name, []);
  for (const member of roster) {
    for (const entry of member.derived.primaries) {
      const list = byProf.get(entry.name);
      if (list)
        list.push({
          characterId: member.characterId,
          characterName: member.characterName,
          entry,
        });
      // A primary not in PRIMARY_PROFESSIONS (shouldn't happen) is ignored here.
    }
  }
  return PRIMARY_PROFESSIONS.map((profession) => ({
    profession,
    // Maxed crafters first, then by skill desc, then name.
    crafters: (byProf.get(profession) ?? []).sort(
      (a, b) =>
        Number(isMaxed(b.entry.current)) - Number(isMaxed(a.entry.current)) ||
        (b.entry.current?.skill ?? -1) - (a.entry.current?.skill ?? -1) ||
        a.characterName.localeCompare(b.characterName),
    ),
  }));
}

// ── Known-recipe listing ("sorted like in game") ─────────────────────────────

export type KnownRecipe = { id: number; name: string };

export type ProfessionKnown = {
  profId: number;
  name: string;
  kind: "primary" | "secondary";
  /** Current-expansion tier id (drives the game-data category fetch), or null. */
  tierId: number | null;
  tierName: string;
  knownRecipes: KnownRecipe[];
};

/**
 * Per profession, the CURRENT-expansion tier's known recipes (with the profId +
 * tierId needed to fetch its game-data categories). Professions with no
 * current-expansion tier are skipped (nothing to list).
 */
export function extractCurrentTierKnown(raw: unknown): ProfessionKnown[] {
  const r = (raw ?? {}) as { primaries?: RawProf[]; secondaries?: RawProf[] };
  const out: ProfessionKnown[] = [];
  const groups: ["primary" | "secondary", RawProf[]][] = [
    ["primary", Array.isArray(r.primaries) ? r.primaries : []],
    ["secondary", Array.isArray(r.secondaries) ? r.secondaries : []],
  ];
  for (const [kind, arr] of groups) {
    for (const p of arr) {
      const tiers = Array.isArray(p.tiers) ? p.tiers : [];
      const cur = tiers.find((t) =>
        normalizeName(t.tier?.name).startsWith(CURRENT_PROFESSION_EXPANSION),
      );
      if (!cur) continue;
      // Dedupe by id up front (keep first) so a malformed upstream duplicate
      // can't drop a recipe in the Map-based grouping or skew recipeCount.
      const seenIds = new Set<number>();
      const known: KnownRecipe[] = (
        Array.isArray(cur.known_recipes) ? cur.known_recipes : []
      )
        .map((kr) => {
          const o = (kr ?? {}) as { id?: number; name?: unknown };
          return { id: num(o.id), name: normalizeName(o.name) };
        })
        .filter((kr) => {
          if (kr.id <= 0 || seenIds.has(kr.id)) return false;
          seenIds.add(kr.id);
          return true;
        });
      out.push({
        profId: num(p.profession?.id),
        name: normalizeName(p.profession?.name),
        kind,
        tierId: num(cur.tier?.id) || null,
        tierName: normalizeName(cur.tier?.name),
        knownRecipes: known,
      });
    }
  }
  return out;
}

export type RecipeCategory = { name: string; recipeIds: number[] };
export type RecipeGroup = { category: string; recipes: KnownRecipe[] };

/**
 * Group a player's known recipes into the in-game category order. Dedupe by id
 * (a cross-listed recipe shows once — first category wins); skip categories with
 * no known recipe; append any known recipe NOT found in a category to a trailing
 * "Other" bucket so a known recipe is NEVER dropped (e.g. post-patch game-data
 * lag). The result is a lossless re-ordering of `known`.
 */
export function groupKnownLikeInGame(
  known: KnownRecipe[],
  categories: RecipeCategory[],
): RecipeGroup[] {
  const byId = new Map(known.map((r) => [r.id, r]));
  const emitted = new Set<number>();
  const groups: RecipeGroup[] = [];
  for (const cat of categories) {
    const recipes: KnownRecipe[] = [];
    for (const id of cat.recipeIds) {
      const r = byId.get(id);
      if (r && !emitted.has(id)) {
        emitted.add(id);
        recipes.push(r);
      }
    }
    if (recipes.length > 0) groups.push({ category: cat.name, recipes });
  }
  const orphans = known.filter((r) => !emitted.has(r.id));
  if (orphans.length > 0) groups.push({ category: "Other", recipes: orphans });
  return groups;
}

/** Alphabetical fallback when game-data categories are unavailable. */
export function groupKnownAlphabetical(known: KnownRecipe[]): RecipeGroup[] {
  if (known.length === 0) return [];
  return [
    {
      category: "All recipes",
      recipes: [...known].sort((a, b) => a.name.localeCompare(b.name)),
    },
  ];
}
