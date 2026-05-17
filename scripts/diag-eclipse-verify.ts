/**
 * Verify the post-fix snapshot shape for the Eclipse roster:
 *   - MplusSnapshot.rioScore + RIO-derived currentRating
 *   - RaidSnapshot.seasonProgress
 *   - WclParseSnapshot: Mythic (diff 5) only, zoneId, reportStartTime set
 *   - VaultSnapshot.slots.world.tracked (false until a WoW Audit key)
 *
 *   node --env-file=.env --import tsx scripts/diag-eclipse-verify.ts
 */
import { db } from "../src/lib/db";

async function main() {
  const team = await db.raidTeam.findFirst({
    where: { name: { contains: "Eclipse", mode: "insensitive" } },
    select: {
      name: true,
      memberships: {
        where: { isActive: true },
        select: { character: { select: { id: true, name: true } } },
      },
    },
  });
  if (!team) {
    console.log("No Eclipse team.");
    await db.$disconnect();
    return;
  }
  console.log(`Team ${team.name} — ${team.memberships.length} members\n`);

  for (const m of team.memberships) {
    const c = m.character;
    const [mplus, raid, vault, wcl] = await Promise.all([
      db.mplusSnapshot.findFirst({
        where: { characterId: c.id },
        orderBy: { capturedAt: "desc" },
        select: { currentRating: true, rioScore: true, capturedAt: true },
      }),
      db.raidSnapshot.findFirst({
        where: { characterId: c.id },
        orderBy: { capturedAt: "desc" },
        select: { seasonProgress: true, capturedAt: true },
      }),
      db.vaultSnapshot.findFirst({
        where: { characterId: c.id },
        orderBy: { capturedAt: "desc" },
        select: { slots: true, capturedAt: true },
      }),
      db.wclParseSnapshot.findMany({
        where: { characterId: c.id },
        orderBy: { capturedAt: "desc" },
        take: 50,
        select: {
          zoneId: true,
          difficulty: true,
          reportStartTime: true,
          encounterName: true,
          percentile: true,
          capturedAt: true,
        },
      }),
    ]);

    const diffs = [...new Set(wcl.map((w) => w.difficulty))];
    const zones = [...new Set(wcl.map((w) => w.zoneId))];
    const withReportTime = wcl.filter((w) => w.reportStartTime != null).length;
    const slots = (vault?.slots ?? {}) as Record<string, unknown>;
    const world = (slots.world ?? null) as Record<string, unknown> | null;

    console.log(`### ${c.name}`);
    console.log(
      `  mplus: rating=${mplus?.currentRating ?? "—"} rioScore=${
        mplus?.rioScore ? JSON.stringify(mplus.rioScore) : "null"
      } @${mplus?.capturedAt?.toISOString() ?? "—"}`,
    );
    console.log(
      `  raid.seasonProgress=${
        raid?.seasonProgress ? JSON.stringify(raid.seasonProgress) : "null"
      }`,
    );
    console.log(
      `  wcl: rows=${wcl.length} difficulties=${JSON.stringify(
        diffs,
      )} zones=${JSON.stringify(zones)} withReportStartTime=${withReportTime}/${wcl.length}`,
    );
    console.log(
      `  vault.world=${world ? JSON.stringify(world) : "null"} (tracked expected false until WoW Audit key)`,
    );
    console.log("");
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
