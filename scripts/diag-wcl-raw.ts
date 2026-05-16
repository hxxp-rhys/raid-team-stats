import { db } from "../src/lib/db";

async function main() {
  const rows = await db.wclParseSnapshot.findMany({
    orderBy: { capturedAt: "desc" },
    take: 4,
    select: { encounterId: true, percentile: true, rawPayload: true },
  });
  for (const r of rows) {
    console.log(
      `enc=${r.encounterId} pct=${r.percentile} raw=${JSON.stringify(r.rawPayload)}`,
    );
  }
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
