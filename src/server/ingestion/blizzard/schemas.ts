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
 * /profile/wow/character/{realmSlug}/{characterName}/specializations
 * — every spec's saved loadouts. We only need the active loadout's
 * `talent_loadout_code` (the copy/paste import string) and the active
 * spec id; kept permissive so Blizzard adding fields never breaks it.
 */
export const characterSpecializationsResponseSchema = z
  .object({
    active_specialization: z
      .object({ id: z.number().int().optional() })
      .passthrough()
      .nullable()
      .optional(),
    specializations: z
      .array(
        z
          .object({
            specialization: z
              .object({ id: z.number().int().optional() })
              .passthrough()
              .optional(),
            loadouts: z
              .array(
                z
                  .object({
                    is_active: z.boolean().optional(),
                    talent_loadout_code: z.string().optional(),
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
export type CharacterSpecializationsResponse = z.infer<
  typeof characterSpecializationsResponseSchema
>;

/**
 * Pull the active loadout's import string from a specializations payload:
 * prefer the loadout flagged active under the active spec, else any active
 * loadout, else null. (No web fallback exists — the addon can't read this
 * on 12.0.)
 */
export function activeLoadoutCode(
  data: CharacterSpecializationsResponse,
): string | null {
  const specs = data.specializations ?? [];
  const pick = (
    loadouts?: { is_active?: boolean; talent_loadout_code?: string }[],
  ): string | null => {
    const a = (loadouts ?? []).find(
      (l) => l.is_active === true && l.talent_loadout_code,
    );
    return a?.talent_loadout_code ?? null;
  };
  const activeId = data.active_specialization?.id ?? null;
  if (activeId != null) {
    const match = specs.find((s) => s.specialization?.id === activeId);
    const code = pick(match?.loadouts);
    if (code) return code;
  }
  for (const s of specs) {
    const code = pick(s.loadouts);
    if (code) return code;
  }
  return null;
}

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

/**
 * /profile/wow/character/{realmSlug}/{characterName}/professions
 * — primaries (max 2) + secondaries, each with per-expansion `tiers` carrying
 * skill points + known recipes. Kept permissive (.passthrough); we only read
 * what the derivation needs. A character with no professions omits both arrays.
 */
const profLocaleName = z
  .union([z.string(), z.record(z.string(), z.string())])
  .optional();
const professionTierSchema = z
  .object({
    tier: z
      .object({ id: z.number().int().optional(), name: profLocaleName })
      .passthrough()
      .optional(),
    skill_points: z.number().optional(),
    max_skill_points: z.number().optional(),
    known_recipes: z.array(z.object({}).passthrough()).optional(),
  })
  .passthrough();
const professionEntrySchema = z
  .object({
    profession: z
      .object({ id: z.number().int().optional(), name: profLocaleName })
      .passthrough()
      .optional(),
    skill_points: z.number().optional(),
    max_skill_points: z.number().optional(),
    tiers: z.array(professionTierSchema).optional(),
  })
  .passthrough();
export const characterProfessionsResponseSchema = z
  .object({
    primaries: z.array(professionEntrySchema).optional(),
    secondaries: z.array(professionEntrySchema).optional(),
  })
  .passthrough();
export type CharacterProfessionsResponse = z.infer<
  typeof characterProfessionsResponseSchema
>;

/**
 * /data/wow/profession/{id}/skill-tier/{tierId} (STATIC namespace) — the recipe
 * CATEGORIES in in-game display order. Each category lists its recipes (flat
 * {id, name}). Permissive: we only read category name + recipe id/name.
 */
export const professionSkillTierResponseSchema = z
  .object({
    id: z.number().int().optional(),
    categories: z
      .array(
        z
          .object({
            name: profLocaleName,
            recipes: z
              .array(
                z
                  .object({ id: z.number().int().optional(), name: profLocaleName })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type ProfessionSkillTierResponse = z.infer<
  typeof professionSkillTierResponseSchema
>;

/**
 * /data/wow/media/journal-instance/{id} (STATIC namespace) — a raid's media
 * assets. We read the `tile` asset (the official zone art at
 * render.worldofwarcraft.com/.../{name}-small.jpg). Permissive: only key+value.
 */
export const journalInstanceMediaResponseSchema = z
  .object({
    assets: z
      .array(
        z
          .object({ key: z.string().optional(), value: z.string().optional() })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type JournalInstanceMediaResponse = z.infer<
  typeof journalInstanceMediaResponseSchema
>;

/**
 * /data/wow/journal-instance/{id} — a raid's data, incl. its `encounters[]`
 * ({ id, name }). Permissive: with the locale pinned, name is a plain string;
 * accept the rare localized-object form too rather than 422 the whole call.
 */
const localizedName = z.union([z.string(), z.record(z.string(), z.string())]);
export const journalInstanceResponseSchema = z
  .object({
    id: z.number().int().optional(),
    name: localizedName.optional(),
    encounters: z
      .array(
        z
          .object({ id: z.number().int(), name: localizedName.optional() })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();
export type JournalInstanceResponse = z.infer<
  typeof journalInstanceResponseSchema
>;

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
