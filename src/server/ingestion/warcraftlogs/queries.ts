import { z } from "zod";

/**
 * GraphQL queries we currently exercise. Each is paired with a zod schema
 * for `data` so callers stay typed at the boundary.
 */

export const CHARACTER_ZONE_RANKINGS_QUERY = /* GraphQL */ `
  query CharacterZoneRankings(
    $name: String!
    $server: String!
    $region: String!
    $zoneID: Int!
    $metric: CharacterPageRankingMetricType
    $difficulty: Int
  ) {
    characterData {
      character(name: $name, serverSlug: $server, serverRegion: $region) {
        id
        name
        zoneRankings(zoneID: $zoneID, metric: $metric, difficulty: $difficulty)
      }
    }
  }
`;

export const characterZoneRankingsResponseSchema = z
  .object({
    characterData: z
      .object({
        character: z
          .object({
            id: z.number().int().nullable().optional(),
            name: z.string().optional(),
            // `zoneRankings` is a JSON scalar in WCL's schema — passthrough.
            zoneRankings: z.unknown().nullable().optional(),
          })
          .nullable()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type CharacterZoneRankingsResponse = z.infer<
  typeof characterZoneRankingsResponseSchema
>;

/**
 * Flat list of every WCL raid/zone (`worldData.zones`, the same shape
 * scripts/wcl-smoke.ts uses). Used to auto-resolve the CURRENT raid tier:
 * the highest-id zone that is NOT frozen and NOT a PTR/M+/Delve zone.
 * (The earlier `worldData.expansions[].zones` variant was unreliable —
 * WCL lumps Classic seasonal expansions in with large ids.)
 */
export const WCL_RAID_ZONES_QUERY = /* GraphQL */ `
  query WclRaidZones {
    worldData {
      zones {
        id
        name
        frozen
      }
    }
  }
`;

export const wclRaidZonesResponseSchema = z
  .object({
    worldData: z
      .object({
        zones: z
          .array(
            z
              .object({
                id: z.number().int(),
                name: z.string().optional(),
                frozen: z.boolean().nullable().optional(),
              })
              .passthrough(),
          )
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

/**
 * Encounters (bosses) for a single zone — used to resolve the current
 * raid tier's boss list so we can request per-encounter rankings.
 */
export const ZONE_ENCOUNTERS_QUERY = /* GraphQL */ `
  query WclZoneEncounters($zoneID: Int!) {
    worldData {
      zone(id: $zoneID) {
        id
        name
        encounters {
          id
          name
        }
      }
    }
  }
`;

export const wclZoneEncountersResponseSchema = z
  .object({
    worldData: z
      .object({
        zone: z
          .object({
            id: z.number().int(),
            name: z.string().optional(),
            encounters: z
              .array(
                z
                  .object({ id: z.number().int(), name: z.string().optional() })
                  .passthrough(),
              )
              .nullable()
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

/**
 * Builds a single batched query that asks for `encounterRankings` (which —
 * unlike `zoneRankings` — exposes individual `ranks[]` each with a
 * `startTime`/`report`) for every current-tier encounter at one difficulty.
 * Aliased per encounter (`e<id>`) so it's one HTTP request per character.
 *
 * `encounterRankings` is a JSON scalar in WCL's schema → passthrough.
 */
export const buildCharacterEncounterRankingsQuery = (
  encounterIds: number[],
): string => {
  const fields = encounterIds
    .map(
      (id) =>
        `e${id}: encounterRankings(encounterID: ${id}, difficulty: $difficulty, metric: dps)`,
    )
    .join("\n        ");
  return /* GraphQL */ `
    query CharEncounterRankings(
      $name: String!
      $server: String!
      $region: String!
      $difficulty: Int
    ) {
      characterData {
        character(name: $name, serverSlug: $server, serverRegion: $region) {
          id
          name
          ${fields}
        }
      }
    }
  `;
};

export const characterEncounterRankingsResponseSchema = z
  .object({
    characterData: z
      .object({
        character: z
          .record(z.string(), z.unknown())
          .nullable()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * GRS discovery — the guild's recent public reports for one zone. All args
 * and returned fields verified by live introspection 2026-06-11
 * (phase2-verify-wcl). `startTime`/`endTime` are epoch ms floats.
 */
export const GUILD_REPORTS_QUERY = /* GraphQL */ `
  query GuildReports(
    $guildName: String!
    $guildServerSlug: String!
    $guildServerRegion: String!
    $zoneID: Int
    $startTime: Float
    $limit: Int
  ) {
    reportData {
      reports(
        guildName: $guildName
        guildServerSlug: $guildServerSlug
        guildServerRegion: $guildServerRegion
        zoneID: $zoneID
        startTime: $startTime
        limit: $limit
      ) {
        data {
          code
          title
          startTime
          endTime
          revision
          zone {
            id
          }
        }
      }
    }
  }
`;

export const guildReportsResponseSchema = z
  .object({
    reportData: z
      .object({
        reports: z
          .object({
            data: z
              .array(
                z
                  .object({
                    code: z.string(),
                    title: z.string().nullable().optional(),
                    startTime: z.number(),
                    endTime: z.number(),
                    revision: z.number().int(),
                    zone: z
                      .object({ id: z.number().int() })
                      .passthrough()
                      .nullable()
                      .optional(),
                  })
                  .passthrough()
                  .nullable(),
              )
              .nullable()
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type GuildReportsResponse = z.infer<typeof guildReportsResponseSchema>;

/**
 * GRS detail — one report's encounter pulls + player actor table. Every
 * requested field verified by live introspection + live probe 2026-06-11:
 * fight startTime/endTime are REPORT-RELATIVE ms (absolute = report
 * startTime + offset); keystoneLevel is null on raid fights (non-null = M+,
 * dropped at ingest); encounterID 0 = trash (excluded by killType but
 * filtered defensively anyway).
 */
export const REPORT_FIGHTS_QUERY = /* GraphQL */ `
  query ReportFights($code: String!) {
    reportData {
      report(code: $code) {
        code
        startTime
        endTime
        revision
        zone {
          id
        }
        fights(killType: Encounters) {
          id
          encounterID
          difficulty
          kill
          size
          bossPercentage
          fightPercentage
          lastPhase
          lastPhaseIsIntermission
          startTime
          endTime
          friendlyPlayers
          keystoneLevel
        }
        masterData {
          actors(type: "Player") {
            id
            name
            server
            subType
          }
        }
      }
    }
  }
`;

export const reportFightsResponseSchema = z
  .object({
    reportData: z
      .object({
        report: z
          .object({
            code: z.string(),
            startTime: z.number(),
            endTime: z.number(),
            // Required to match the discovery schema: a divergent (defaulted)
            // revision would never equal discovery's and the report would
            // re-fetch every run forever. Live data always carries it.
            revision: z.number().int(),
            zone: z
              .object({ id: z.number().int() })
              .passthrough()
              .nullable()
              .optional(),
            fights: z
              .array(
                z
                  .object({
                    id: z.number().int(),
                    encounterID: z.number().int(),
                    difficulty: z.number().int().nullable().optional(),
                    kill: z.boolean().nullable().optional(),
                    size: z.number().int().nullable().optional(),
                    bossPercentage: z.number().nullable().optional(),
                    fightPercentage: z.number().nullable().optional(),
                    lastPhase: z.number().int().nullable().optional(),
                    lastPhaseIsIntermission: z
                      .boolean()
                      .nullable()
                      .optional(),
                    startTime: z.number(),
                    endTime: z.number(),
                    friendlyPlayers: z
                      .array(z.number().int().nullable())
                      .nullable()
                      .optional(),
                    keystoneLevel: z.number().int().nullable().optional(),
                  })
                  .passthrough()
                  .nullable(),
              )
              .nullable()
              .optional(),
            masterData: z
              .object({
                actors: z
                  .array(
                    z
                      .object({
                        id: z.number().int(),
                        name: z.string(),
                        server: z.string().nullable().optional(),
                        subType: z.string().nullable().optional(),
                      })
                      .passthrough()
                      .nullable(),
                  )
                  .nullable()
                  .optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type ReportFightsResponse = z.infer<typeof reportFightsResponseSchema>;
