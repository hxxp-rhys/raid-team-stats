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
