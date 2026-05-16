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
  for (const mem of team?.memberships ?? []) {
    const m = await db.mplusSnapshot.findFirst({
      where: { characterId: mem.character.id },
      orderBy: { capturedAt: "desc" },
      select: {
        weeklyRunCount: true,
        weeklyHighest: true,
        runsThisWeek: true,
      },
    });
    const distinct = Array.isArray(m?.runsThisWeek)
      ? (m!.runsThisWeek as unknown[]).length
      : null;
    const slots =
      (m?.weeklyRunCount ?? 0) >= 8
        ? 3
        : (m?.weeklyRunCount ?? 0) >= 4
          ? 2
          : (m?.weeklyRunCount ?? 0) >= 1
            ? 1
            : 0;
    console.log(
      `${mem.character.name}: weeklyRunCount=${m?.weeklyRunCount} (blizzardDistinct=${distinct}) weeklyHighest=${m?.weeklyHighest} → vault ${slots}/3`,
    );
  }
  // WCL zone sanity
  const wcl = await db.wclParseSnapshot.findFirst({
    orderBy: { capturedAt: "desc" },
    select: { zoneId: true, encounterName: true },
  });
  console.log(`Latest WCL snapshot: zone=${wcl?.zoneId} boss=${wcl?.encounterName}`);
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
