import { z } from "zod";

/**
 * Blizzard responses vary across regions and game-data releases. Schemas use
 * `.passthrough()` so additive fields (new tier sets, new vault categories)
 * don't break the parser; only the fields we actively use are typed.
 */

const link = z
  .object({
    href: z.string().url().optional(),
  })
  .passthrough();

export const appTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default("bearer"),
  expires_in: z.number().int().positive(),
  sub: z.string().optional(),
});
export type AppTokenResponse = z.infer<typeof appTokenResponseSchema>;

// /profile/user/wow — list of characters owned by the calling BattleTag.
export const userCharactersResponseSchema = z
  .object({
    wow_accounts: z
      .array(
        z
          .object({
            characters: z
              .array(
                z
                  .object({
                    id: z.coerce.bigint(),
                    name: z.string(),
                    realm: z
                      .object({
                        slug: z.string(),
                        id: z.number().optional(),
                        name: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
                      })
                      .passthrough(),
                    level: z.number().int().nonnegative().optional(),
                    playable_class: z
                      .object({ id: z.number().int() })
                      .passthrough()
                      .optional(),
                    playable_race: z
                      .object({ id: z.number().int() })
                      .passthrough()
                      .optional(),
                    faction: z
                      .object({ type: z.string() })
                      .passthrough()
                      .optional(),
                  })
                  .passthrough(),
              )
              .default([]),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type UserCharactersResponse = z.infer<typeof userCharactersResponseSchema>;

// /profile/wow/character/{realm}/{name} — single-character summary.
export const characterSummaryResponseSchema = z
  .object({
    id: z.coerce.bigint(),
    name: z.string(),
    level: z.number().int().nonnegative().optional(),
    character_class: z
      .object({ id: z.number().int() })
      .passthrough()
      .optional(),
    race: z
      .object({ id: z.number().int(), name: z.union([z.string(), z.record(z.string(), z.string())]).optional() })
      .passthrough()
      .optional(),
    faction: z
      .object({ type: z.string() })
      .passthrough()
      .optional(),
    equipped_item_level: z.number().int().nonnegative().optional(),
    average_item_level: z.number().int().nonnegative().optional(),
    realm: z
      .object({ slug: z.string() })
      .passthrough()
      .optional(),
    guild: z
      .object({
        name: z.string(),
        realm: z
          .object({ slug: z.string() })
          .passthrough(),
        faction: z
          .object({ type: z.string() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    active_spec: z
      .object({
        id: z.number().int().optional(),
        name: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type CharacterSummaryResponse = z.infer<typeof characterSummaryResponseSchema>;

/**
 * /profile/wow/character/{realmSlug}/{characterName}/encounters/raids
 * — per-expansion → per-instance → per-mode → per-encounter completion list.
 * Schema kept minimal; raw payload is preserved for replay.
 */
export const raidEncountersResponseSchema = z
  .object({
    character: z.object({ id: z.coerce.bigint() }).passthrough().optional(),
    expansions: z
      .array(
        z
          .object({
            expansion: z
              .object({ id: z.number().int(), name: z.union([z.string(), z.record(z.string(), z.string())]).optional() })
              .passthrough()
              .optional(),
            instances: z
              .array(
                z
                  .object({
                    instance: z
                      .object({
                        id: z.number().int(),
                        name: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
                      })
                      .passthrough()
                      .optional(),
                    modes: z
                      .array(
                        z
                          .object({
                            difficulty: z
                              .object({
                                type: z.string(),
                                name: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
                              })
                              .passthrough()
                              .optional(),
                            status: z
                              .object({ type: z.string() })
                              .passthrough()
                              .optional(),
                            progress: z
                              .object({
                                completed_count: z.number().int().nonnegative().optional(),
                                total_count: z.number().int().nonnegative().optional(),
                                encounters: z
                                  .array(
                                    z
                                      .object({
                                        encounter: z
                                          .object({
                                            id: z.number().int(),
                                            name: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
                                          })
                                          .passthrough()
                                          .optional(),
                                        completed_count: z.number().int().nonnegative().optional(),
                                        last_kill_timestamp: z.number().optional(),
                                      })
                                      .passthrough(),
                                  )
                                  .optional(),
                              })
                              .passthrough()
                              .optional(),
                          })
                          .passthrough(),
                      )
                      .optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type RaidEncountersResponse = z.infer<typeof raidEncountersResponseSchema>;

// /data/wow/guild/{realm}/{slug}/roster — paginated roster.
export const guildRosterResponseSchema = z
  .object({
    guild: z
      .object({ id: z.number().int() })
      .passthrough()
      .optional(),
    members: z
      .array(
        z
          .object({
            character: z
              .object({
                id: z.coerce.bigint(),
                name: z.string(),
                level: z.number().int().nonnegative().optional(),
                realm: z
                  .object({ slug: z.string() })
                  .passthrough(),
                playable_class: z
                  .object({ id: z.number().int() })
                  .passthrough()
                  .optional(),
                playable_race: z
                  .object({ id: z.number().int() })
                  .passthrough()
                  .optional(),
                faction: z
                  .object({ type: z.string() })
                  .passthrough()
                  .optional(),
              })
              .passthrough(),
            rank: z.number().int().nonnegative(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type GuildRosterResponse = z.infer<typeof guildRosterResponseSchema>;

/**
 * /profile/wow/character/{realmSlug}/{characterName}/mythic-keystone-profile
 * — overall M+ index: current rating + list of seasons the character has any
 * progress in. Each `seasons[n].href` ends in `/season/{id}` which we parse
 * to locate the current season number.
 */
const keystoneRunSchema = z
  .object({
    keystone_level: z.number().int().nonnegative().optional(),
    is_completed_within_time: z.boolean().optional(),
    duration: z.number().optional(),
    completed_timestamp: z.number().optional(),
    dungeon: z
      .object({
        id: z.number().int(),
        name: z
          .union([z.string(), z.record(z.string(), z.string())])
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const mythicKeystoneIndexResponseSchema = z
  .object({
    current_mythic_rating: z
      .object({ rating: z.number().optional() })
      .passthrough()
      .optional(),
    current_period: z
      .object({
        period: z
          .object({ id: z.number().int().optional() })
          .passthrough()
          .optional(),
        // Runs completed in the CURRENT weekly M+ period — this is what
        // drives Great Vault progress (1/4/8 runs → 1/2/3 slots). One entry
        // per dungeon (best run for the period).
        best_runs: z.array(keystoneRunSchema).optional(),
      })
      .passthrough()
      .optional(),
    seasons: z
      .array(
        z
          .object({
            id: z.number().int().optional(),
            key: z.object({ href: z.string().optional() }).passthrough().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type MythicKeystoneIndexResponse = z.infer<typeof mythicKeystoneIndexResponseSchema>;

/**
 * /profile/wow/character/{realmSlug}/{characterName}/mythic-keystone-profile/season/{seasonId}
 * — per-season detail: best runs (one per dungeon) + weekly highest.
 */
export const mythicKeystoneSeasonResponseSchema = z
  .object({
    season: z.object({ id: z.number().int() }).passthrough().optional(),
    best_runs: z
      .array(
        z
          .object({
            keystone_level: z.number().int().nonnegative().optional(),
            is_completed_within_time: z.boolean().optional(),
            duration: z.number().optional(),
            completed_timestamp: z.number().optional(),
            dungeon: z
              .object({
                id: z.number().int(),
                name: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    mythic_rating: z
      .object({ rating: z.number().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type MythicKeystoneSeasonResponse = z.infer<typeof mythicKeystoneSeasonResponseSchema>;

export const FACTION_MAP: Record<string, "ALLIANCE" | "HORDE" | "NEUTRAL"> = {
  ALLIANCE: "ALLIANCE",
  HORDE: "HORDE",
  NEUTRAL: "NEUTRAL",
  Alliance: "ALLIANCE",
  Horde: "HORDE",
  Neutral: "NEUTRAL",
};

// Avoid an unused-import warning when the schema only re-exports types.
export const _link = link;
