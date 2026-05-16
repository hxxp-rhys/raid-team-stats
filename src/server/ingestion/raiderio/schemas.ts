import { z } from "zod";

/**
 * Raider.IO character profile. `.passthrough()` at every level so additive
 * fields (new season indexes, new vault categories) don't break the parser.
 *
 * Field selection is up to the caller — every named optional field is only
 * present when the corresponding "fields=" entry was requested in the URL.
 */
export const raiderIOCharacterProfileSchema = z
  .object({
    name: z.string(),
    race: z.string().optional(),
    class: z.string().optional(),
    active_spec_name: z.string().optional(),
    active_spec_role: z.string().optional(),
    gender: z.string().optional(),
    faction: z.string().optional(),
    achievement_points: z.number().int().nonnegative().optional(),
    thumbnail_url: z.string().url().optional(),
    region: z.string().optional(),
    realm: z.string().optional(),
    profile_url: z.string().url().optional(),
    last_crawled_at: z.string().optional(),

    // mythic_plus_scores_by_season:current
    mythic_plus_scores_by_season: z
      .array(
        z
          .object({
            season: z.string(),
            scores: z.record(z.string(), z.number()),
          })
          .passthrough(),
      )
      .optional(),

    // mythic_plus_weekly_highest_level_runs — highest run PER DUNGEON this
    // week (deduplicated). Good for "highest key" but not a run count.
    mythic_plus_weekly_highest_level_runs: z
      .array(
        z
          .object({
            dungeon: z.string(),
            short_name: z.string().optional(),
            mythic_level: z.number().int().nonnegative(),
            completed_at: z.string().optional(),
            num_keystone_upgrades: z.number().int().nonnegative().optional(),
            score: z.number().optional(),
          })
          .passthrough(),
      )
      .optional(),

    // mythic_plus_recent_runs — the most recent individual runs (repeats
    // included), each with an ISO `completed_at`. Counting those completed
    // after the weekly reset gives the EXACT vault run count in the 0–8
    // band that determines slot unlocks.
    mythic_plus_recent_runs: z
      .array(
        z
          .object({
            dungeon: z.string(),
            short_name: z.string().optional(),
            mythic_level: z.number().int().nonnegative(),
            completed_at: z.string().optional(),
            num_keystone_upgrades: z.number().int().nonnegative().optional(),
            score: z.number().optional(),
          })
          .passthrough(),
      )
      .optional(),

    // raid_progression
    raid_progression: z.record(z.string(), z.unknown()).optional(),

    // gear
    gear: z
      .object({
        item_level_equipped: z.number().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type RaiderIOCharacterProfile = z.infer<typeof raiderIOCharacterProfileSchema>;
