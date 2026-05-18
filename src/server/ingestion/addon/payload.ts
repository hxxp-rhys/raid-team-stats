import { z } from "zod";

/**
 * Schema + derivation for the in-game addon payload (Stat Smith addon).
 *
 * This is the ONLY authoritative source for the World/Delve Great Vault row
 * — no Blizzard web API exposes it. Kept permissive (`.passthrough()`,
 * mostly optional) so a future addon version that adds fields never breaks
 * ingestion; the full raw payload is stored for replay regardless.
 */

/**
 * Lua serializes an EMPTY table as `{}` (a JSON object), never `[]`. So
 * any list the addon couldn't fill (no raid lockout this reset, empty
 * currency list, no loose gear in bags…) — or a collector that errored
 * and fell back to `{}` via safe() — arrives as `{}`, and a bare
 * `z.array()` rejects it → HTTP 422 and the WHOLE upload is lost. Coerce
 * `{}` / null / undefined → [] at the boundary so a real array still
 * validates but an empty/absent one degrades gracefully.
 */
const luaArray = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess(
    (v) =>
      v == null ||
      (typeof v === "object" &&
        !Array.isArray(v) &&
        Object.keys(v as Record<string, unknown>).length === 0)
        ? []
        : v,
    z.array(item),
  );

const activitySchema = z
  .object({
    type: z.number().optional(),
    index: z.number().optional(),
    threshold: z.number().optional(),
    progress: z.number().optional(),
    level: z.number().optional(),
    unlocked: z.boolean().optional(),
    // SCHEMA 2: projected reward item link for this row (and its post-
    // upgrade preview) — addon ≥ 1.1.0 only.
    rewardExamples: z
      .object({
        item: z.string().nullable().optional(),
        upgrade: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const addonPayloadSchema = z
  .object({
    schema: z.number().optional(),
    addonVersion: z.string().optional(),
    collectedAt: z.number().int().nonnegative(),
    character: z
      .object({
        name: z.string().min(1),
        realm: z.string().min(1),
        region: z.string().min(1),
        class: z.string().optional(),
        spec: z.string().optional(),
        level: z.number().optional(),
        faction: z.string().optional(),
      })
      .passthrough(),
    vault: z
      .object({
        activities: luaArray(activitySchema),
        hasRewards: z.boolean().nullable().optional(),
        enum: z.record(z.string(), z.number()).default({}),
      })
      .passthrough()
      .default({ activities: [], enum: {} }),
    mythicPlus: z
      .object({
        weeklyRuns: luaArray(
          z
            .object({
              level: z.number().optional(),
              completed: z.boolean().optional(),
            })
            .passthrough(),
        ),
        season: z.number().nullable().optional(),
        // SCHEMA 2: the keystone currently in the player's bag (no web
        // API exposes this — Blizzard/RIO only show completed runs).
        ownedKeystone: z
          .object({
            mapId: z.number().nullable().optional(),
            level: z.number().nullable().optional(),
            mapName: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .default({ weeklyRuns: [] }),
    gear: z.unknown().optional(),
    talents: z.unknown().optional(),

    // ─── SCHEMA 2 (addon ≥ 1.1.0) ──────────────────────────────────────
    // All optional so v1 payloads still validate; root is .passthrough()
    // so even unknown future keys survive into AddonUpload.payload. These
    // explicit shapes document the contract for the future widgets that
    // will consume them. The addon dumps raw ids/enums/subclass numbers
    // for stable server-side mapping (same approach as the vault enum).
    currencies: luaArray(
      z
        .object({
          id: z.number().nullable().optional(),
          name: z.string().optional(),
          quantity: z.number().optional(),
          maxQuantity: z.number().optional(),
          totalEarned: z.number().optional(),
          earnedThisWeek: z.number().optional(),
        })
        .passthrough(),
    ),
    inventory: z
      .object({
        items: luaArray(
          z
            .object({
              link: z.string(),
              bag: z.number().optional(),
              slot: z.number().optional(),
            })
            .passthrough(),
        ),
        scanned: z.number().optional(),
      })
      .passthrough()
      .optional(),
    delves: z
      .object({
        api: z.record(z.string(), z.unknown()).optional(),
        companion: z
          .object({
            level: z.number().nullable().optional(),
            name: z.string().nullable().optional(),
            xp: z.number().nullable().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    lockouts: luaArray(
      z
        .object({
          name: z.string().optional(),
          isRaid: z.boolean().optional(),
          difficulty: z.string().nullable().optional(),
          difficultyId: z.number().nullable().optional(),
          locked: z.boolean().optional(),
          extended: z.boolean().optional(),
          encounters: z.number().nullable().optional(),
          progress: z.number().nullable().optional(),
          bosses: luaArray(
            z
              .object({
                name: z.string().optional(),
                killed: z.boolean().optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
    consumables: z
      .object({
        items: luaArray(
          z
            .object({
              id: z.number().optional(),
              name: z.string().nullable().optional(),
              sub: z.number().nullable().optional(),
              count: z.number().optional(),
            })
            .passthrough(),
        ),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AddonPayload = z.infer<typeof addonPayloadSchema>;

export const REGION_MAP: Record<string, "US" | "EU" | "KR" | "TW"> = {
  us: "US",
  eu: "EU",
  kr: "KR",
  tw: "TW",
};

/** Normalize a realm/character name for cross-source matching. */
export const normalizeKey = (s: string): string =>
  s.normalize("NFKD").toLowerCase().replace(/['\s_-]/g, "");

type DerivedVault = {
  raidUnlocked: number | null;
  mplusUnlocked: number | null;
  worldUnlocked: number | null;
  worldTotal: number;
  weeklyMplusRuns: number;
};

/**
 * Resolve the Great-Vault unlocked-slot counts from the weekly-reward
 * activities. The addon dumps the live `Enum.WeeklyRewardChestThresholdType`
 * (names→numbers) so we map by NAME (stable across patches) rather than
 * hard-coding numbers that Blizzard reshuffles. A category unlocks at most
 * 3 slots; count activities whose progress met the threshold.
 */
export function deriveVault(payload: AddonPayload): DerivedVault {
  const enumMap = payload.vault.enum ?? {};
  const findType = (...names: string[]): number | null => {
    for (const [k, v] of Object.entries(enumMap)) {
      const kl = k.toLowerCase();
      if (names.some((n) => kl === n)) return v;
    }
    return null;
  };
  const raidType = findType("raid");
  const mplusType = findType("activities", "mythicplus", "mythic_plus");
  const worldType = findType("world");

  const countUnlocked = (t: number | null): number | null => {
    if (t == null) return null;
    let n = 0;
    for (const a of payload.vault.activities) {
      if (a.type !== t) continue;
      const unlocked =
        a.unlocked === true ||
        (typeof a.progress === "number" &&
          typeof a.threshold === "number" &&
          a.threshold > 0 &&
          a.progress >= a.threshold);
      if (unlocked) n++;
    }
    return Math.min(n, 3);
  };

  const weeklyMplusRuns = payload.mythicPlus.weeklyRuns.filter(
    (r) => r.completed !== false,
  ).length;

  return {
    raidUnlocked: countUnlocked(raidType),
    mplusUnlocked: countUnlocked(mplusType),
    worldUnlocked: countUnlocked(worldType),
    worldTotal: 3,
    weeklyMplusRuns,
  };
}

export type VaultRow = {
  threshold: number | null;
  progress: number | null;
  level: number | null;
  unlocked: boolean;
};
export type VaultDetailCategory = {
  kind: "raid" | "mplus" | "world";
  rows: VaultRow[];
};

/**
 * Per-row Great Vault detail for all three categories (schema-2 widget
 * data). Same enum-by-name mapping as deriveVault, but keeps each slot's
 * threshold / progress / unlock level instead of just the count.
 */
export function deriveVaultDetail(
  payload: AddonPayload,
): VaultDetailCategory[] {
  const enumMap = payload.vault.enum ?? {};
  const findType = (...names: string[]): number | null => {
    for (const [k, v] of Object.entries(enumMap)) {
      if (names.includes(k.toLowerCase())) return v;
    }
    return null;
  };
  const cats: Array<{ kind: VaultDetailCategory["kind"]; type: number | null }> =
    [
      { kind: "raid", type: findType("raid") },
      {
        kind: "mplus",
        type: findType("activities", "mythicplus", "mythic_plus"),
      },
      { kind: "world", type: findType("world") },
    ];
  return cats.map(({ kind, type }) => ({
    kind,
    rows:
      type == null
        ? []
        : payload.vault.activities
            .filter((a) => a.type === type)
            .sort((a, b) => (a.threshold ?? 0) - (b.threshold ?? 0))
            .map((a) => ({
              threshold: a.threshold ?? null,
              progress: a.progress ?? null,
              level: a.level ?? null,
              unlocked:
                a.unlocked === true ||
                (typeof a.progress === "number" &&
                  typeof a.threshold === "number" &&
                  a.threshold > 0 &&
                  a.progress >= a.threshold),
            })),
  }));
}
