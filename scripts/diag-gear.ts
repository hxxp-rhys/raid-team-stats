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
  if (!team) return console.log("no eclipse team");
  for (const m of team.memberships) {
    const eq = await db.equipmentSnapshot.findFirst({
      where: { characterId: m.character.id },
      orderBy: { capturedAt: "desc" },
      select: {
        missingEnchantsCount: true,
        missingGemsCount: true,
        tierSetPiecesCount: true,
        itemLevel: true,
      },
    });
    console.log(
      `${m.character.name}: iLvl=${eq?.itemLevel} missingEnch=${eq?.missingEnchantsCount} missingGems=${eq?.missingGemsCount} tier=${eq?.tierSetPiecesCount}`,
    );
  }
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
