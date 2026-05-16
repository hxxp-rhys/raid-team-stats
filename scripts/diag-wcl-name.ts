import { db } from "../src/lib/db";

async function main() {
  const r = await db.wclParseSnapshot.findMany({
    orderBy: { capturedAt: "desc" },
    take: 6,
    select: { encounterId: true, encounterName: true, percentile: true },
  });
  console.log(JSON.stringify(r, null, 2));
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
