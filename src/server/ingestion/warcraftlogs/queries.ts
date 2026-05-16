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
  ) {
    characterData {
      character(name: $name, serverSlug: $server, serverRegion: $region) {
        id
        name
        zoneRankings(zoneID: $zoneID, metric: $metric)
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
 * Lists every raid zone WCL knows, newest last. Used to auto-resolve the
 * CURRENT raid tier (highest id, with encounters) so the parses widgets
 * track the live raid (e.g. WoW Midnight) without a hardcoded zone id.
 */
export const WCL_RAID_ZONES_QUERY = /* GraphQL */ `
  query WclRaidZones {
    worldData {
      expansions {
        id
        name
        zones {
          id
          name
          frozen
          encounters { id name }
        }
      }
    }
  }
`;

export const wclRaidZonesResponseSchema = z
  .object({
    worldData: z
      .object({
        expansions: z
          .array(
            z
              .object({
                id: z.number().int(),
                name: z.string().optional(),
                zones: z
                  .array(
                    z
                      .object({
                        id: z.number().int(),
                        name: z.string().optional(),
                        frozen: z.boolean().nullable().optional(),
                        encounters: z
                          .array(
                            z
                              .object({
                                id: z.number().int(),
                                name: z.string().optional(),
                              })
                              .passthrough(),
                          )
                          .nullable()
                          .optional(),
                      })
                      .passthrough(),
                  )
                  .nullable()
                  .optional(),
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
