/**
 * Dev smoke: probe Warcraft Logs v2 GraphQL with the configured client
 * credentials. Lists the most recently added zones so we can identify the
 * current raid tier's zoneID for Tier-A ingestion. Refuses to run in
 * production.
 */
import { z } from "zod";

import { warcraftLogsClient } from "@/server/ingestion/warcraftlogs/client";

const ZONES_QUERY = /* GraphQL */ `
  query Zones {
    worldData {
      zones {
        id
        name
        frozen
      }
    }
  }
`;

const schema = z.object({
  worldData: z.object({
    zones: z
      .array(
        z.object({
          id: z.number(),
          name: z.string(),
          frozen: z.boolean().nullable().optional(),
        }),
      )
      .default([]),
  }),
});

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run in production.");
    process.exit(2);
  }
  const c = warcraftLogsClient();
  const r = await c.query({ query: ZONES_QUERY, schema, estimatedPoints: 1 });
  // Print only the 20 most recent (largest id) zones. Frozen zones are the
  // old, locked-in raid tiers.
  const recent = [...r.worldData.zones].sort((a, b) => b.id - a.id).slice(0, 20);
  for (const z of recent) {
    console.log(z.id, z.name, z.frozen ? "(frozen)" : "");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
