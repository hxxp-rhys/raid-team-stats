import { db } from "../src/lib/db";

async function main() {
  const total = await db.wclParseSnapshot.count();
  console.log("Total WclParseSnapshot rows:", total);
  const sample = await db.wclParseSnapshot.findMany({
    orderBy: { capturedAt: "desc" },
    take: 12,
    select: {
      characterId: true,
      zoneId: true,
      encounterId: true,
      difficulty: true,
      percentile: true,
      metric: true,
      reportCode: true,
      capturedAt: true,
    },
  });
  console.log("Sample rows:");
  for (const r of sample) {
    console.log(
      `  enc=${r.encounterId} diff=${r.difficulty} pct=${r.percentile} metric=${r.metric} zone=${r.zoneId} report=${r.reportCode}`,
    );
  }
  // distinct encounterIds + difficulties
  const encs = await db.wclParseSnapshot.groupBy({
    by: ["encounterId", "difficulty"],
    _count: { _all: true },
    _avg: { percentile: true },
  });
  console.log("Distinct enc/diff:");
  for (const e of encs.slice(0, 30)) {
    console.log(
      `  enc=${e.encounterId} diff=${e.difficulty} n=${e._count._all} avgPct=${e._avg.percentile}`,
    );
  }
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
