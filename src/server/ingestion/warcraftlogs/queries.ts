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
    $metric: CharacterRankingMetricType
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
