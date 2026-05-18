import { env } from "@/env";
import { buildCharacterPath, normalizeRealmSlug } from "@/lib/realm";

type RegionCode = "us" | "eu" | "kr" | "tw";

const lowerRegion = (r: string): RegionCode => r.toLowerCase() as RegionCode;

export const battleNetOAuthBase = (region: string): string =>
  `https://${lowerRegion(region)}.battle.net/oauth`;

export const blizzardApiBase = (region: string): string =>
  `https://${lowerRegion(region)}.api.blizzard.com`;

/**
 * Common URL builders. All paths are appended to `blizzardApiBase(region)`
 * with a namespace + locale query string so the caller doesn't have to wire
 * those for every endpoint.
 */
export type BlizzardPath = {
  path: string;
  namespace: string;
};

const profileNamespace = (region: string) => `profile-${lowerRegion(region)}`;

export const endpoints = {
  /** GET — characters owned by the calling BattleTag. Requires user OAuth. */
  userCharacters: (region: string): BlizzardPath => ({
    path: "/profile/user/wow",
    namespace: profileNamespace(region),
  }),

  /** GET — single character summary (level, class, race, faction, guild). */
  characterSummary: (
    region: string,
    realmSlug: string,
    characterName: string,
  ): BlizzardPath => ({
    path: `/profile/wow/character/${buildCharacterPath(realmSlug, characterName)}`,
    namespace: profileNamespace(region),
  }),

  /** GET — character equipment (items, enchants, gems). */
  characterEquipment: (
    region: string,
    realmSlug: string,
    characterName: string,
  ): BlizzardPath => ({
    path: `/profile/wow/character/${buildCharacterPath(realmSlug, characterName)}/equipment`,
    namespace: profileNamespace(region),
  }),

  /**
   * GET — character specializations: every spec's saved loadouts incl. the
   * `talent_loadout_code` export string and `active_specialization`. WoW
   * 12.0 locks the loadout away from in-game addons, so this authenticated
   * endpoint is the only source for the Talent-builds widget.
   */
  characterSpecializations: (
    region: string,
    realmSlug: string,
    characterName: string,
  ): BlizzardPath => ({
    path: `/profile/wow/character/${buildCharacterPath(realmSlug, characterName)}/specializations`,
    namespace: profileNamespace(region),
  }),

  /** GET — M+ index for a character (current overall rating + season list). */
  characterMythicKeystoneIndex: (
    region: string,
    realmSlug: string,
    characterName: string,
  ): BlizzardPath => ({
    path: `/profile/wow/character/${buildCharacterPath(realmSlug, characterName)}/mythic-keystone-profile`,
    namespace: profileNamespace(region),
  }),

  /** GET — M+ profile for a specific season. */
  characterMythicKeystone: (
    region: string,
    realmSlug: string,
    characterName: string,
    seasonId: number,
  ): BlizzardPath => ({
    path: `/profile/wow/character/${buildCharacterPath(realmSlug, characterName)}/mythic-keystone-profile/season/${seasonId}`,
    namespace: profileNamespace(region),
  }),

  /** GET — raid completion summary. */
  characterRaids: (
    region: string,
    realmSlug: string,
    characterName: string,
  ): BlizzardPath => ({
    path: `/profile/wow/character/${buildCharacterPath(realmSlug, characterName)}/encounters/raids`,
    namespace: profileNamespace(region),
  }),

  /** GET — guild roster (members, ranks). */
  guildRoster: (region: string, realmSlug: string, guildSlug: string): BlizzardPath => {
    const realm = normalizeRealmSlug(realmSlug);
    const guild = normalizeRealmSlug(guildSlug);
    if (!realm || !guild) {
      throw new Error("guildRoster: realm and guild slugs are required");
    }
    return {
      path: `/data/wow/guild/${realm}/${guild}/roster`,
      // The /data/wow/guild/* endpoints use the profile namespace, not
      // dynamic — despite living under /data/. Blizzard's own docs disagree
      // with the actual gateway here; profile-{region} is what works.
      namespace: profileNamespace(region),
    };
  },
};

/**
 * Returns the default region used when none is supplied. Tier B / Tier C
 * jobs operate per-guild and pass the guild's stored region. This default
 * is used only for app-token requests (which are region-scoped but the same
 * client credentials work across regions).
 */
export const defaultRegion = (): string => env.BLIZZARD_REGION;
