import { z } from "zod";

/**
 * Schema + derivation for the in-game addon payload (RaidTeamStatsUploader).
 *
 * This is the ONLY authoritative source for the World/Delve Great Vault row
 * — no Blizzard web API exposes it. Kept permissive (`.passthrough()`,
 * mostly optional) so a future addon version that adds fields never breaks
 * ingestion; the full raw payload is stored for replay regardless.
 */

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
        activities: z.array(activitySchema).default([]),
        hasRewards: z.boolean().nullable().optional(),
        enum: z.record(z.string(), z.number()).default({}),
      })
      .passthrough()
      .default({ activities: [], enum: {} }),
    mythicPlus: z
      .object({
        weeklyRuns: z
          .array(
            z
              .object({
                level: z.number().optional(),
                completed: z.boolean().optional(),
              })
              .passthrough(),
          )
          .default([]),
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
    currencies: z
      .array(
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
      )
      .optional(),
    inventory: z
      .object({
        items: z
          .array(
            z
              .object({
                link: z.string(),
                bag: z.number().optional(),
                slot: z.number().optional(),
              })
              .passthrough(),
          )
          .default([]),
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
    lockouts: z
      .array(
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
            bosses: z
              .array(
                z
                  .object({
                    name: z.string().optional(),
                    killed: z.boolean().optional(),
                  })
                  .passthrough(),
              )
              .default([]),
          })
          .passthrough(),
      )
      .optional(),
    consumables: z
      .object({
        items: z
          .array(
            z
              .object({
                id: z.number().optional(),
                name: z.string().nullable().optional(),
                sub: z.number().nullable().optional(),
                count: z.number().optional(),
              })
              .passthrough(),
          )
          .default([]),
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
