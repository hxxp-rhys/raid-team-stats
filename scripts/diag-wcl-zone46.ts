import { z } from "zod";
import { warcraftLogsClient } from "@/server/ingestion/warcraftlogs/client";

const Q = /* GraphQL */ `
  query Z($id: Int!) {
    worldData {
      zone(id: $id) {
        id
        name
        frozen
        encounters { id name }
        difficulties { id name }
      }
    }
  }
`;
const schema = z.object({
  worldData: z.object({
    zone: z
      .object({
        id: z.number(),
        name: z.string(),
        frozen: z.boolean().nullable().optional(),
        encounters: z.array(z.object({ id: z.number(), name: z.string() })).nullable().optional(),
        difficulties: z.array(z.object({ id: z.number(), name: z.string() })).nullable().optional(),
      })
      .nullable(),
  }),
});

async function main() {
  const wcl = warcraftLogsClient();
  for (const id of [46, 50]) {
    const r = await wcl.query({ query: Q, variables: { id }, schema, estimatedPoints: 2 });
    const z = r.worldData.zone;
    console.log(
      `zone ${id}: name="${z?.name}" frozen=${z?.frozen} encounters=${z?.encounters?.length ?? 0} difficulties=${JSON.stringify(z?.difficulties?.map((d) => d.name))}`,
    );
    for (const e of z?.encounters ?? []) console.log(`   - ${e.id} ${e.name}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
