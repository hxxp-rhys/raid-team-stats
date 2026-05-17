/**
 * Dump the newest WCL parse row's rawPayload + key fields for an Eclipse
 * character so we can see the ACTUAL zoneRankings ranking shape (does it
 * carry a report timestamp, and under what key?).
 *
 *   node --env-file=.env --import tsx scripts/diag-wcl-shape.ts
 */
import { db } from "../src/lib/db";

async function main() {
  const team = await db.raidTeam.findFirst({
    where: { name: { contains: "Eclipse", mode: "insensitive" } },
    select: {
      memberships: {
        where: { isActive: true },
        select: { character: { select: { id: true, name: true } } },
      },
    },
  });
  const ids = team?.memberships.map((m) => m.character.id) ?? [];
  if (ids.length === 0) {
    console.log("no eclipse members");
    await db.$disconnect();
    return;
  }
  const rows = await db.wclParseSnapshot.findMany({
    where: { characterId: { in: ids } },
    orderBy: { capturedAt: "desc" },
    take: 6,
    select: {
      encounterName: true,
      zoneId: true,
      difficulty: true,
      percentile: true,
      reportStartTime: true,
      capturedAt: true,
      rawPayload: true,
    },
  });
  for (const r of rows) {
    console.log(
      `\n# ${r.encounterName} zone=${r.zoneId} diff=${r.difficulty} pct=${r.percentile} rst=${
        r.reportStartTime?.toISOString() ?? "null"
      } cap=${r.capturedAt.toISOString()}`,
    );
    console.log("rawPayload=", JSON.stringify(r.rawPayload, null, 1));
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
