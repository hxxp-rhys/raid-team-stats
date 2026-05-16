import { db } from "../src/lib/db";
import { handleTrackedMemberSync } from "../src/server/ingestion/jobs/tracked-member-sync";

async function main() {
  const team = await db.raidTeam.findFirst({
    where: { name: { contains: "Eclipse", mode: "insensitive" } },
    select: {
      id: true,
      name: true,
      memberships: {
        where: { isActive: true },
        select: { characterId: true, character: { select: { name: true } } },
      },
    },
  });
  if (!team) {
    console.log("No Eclipse team found.");
    return;
  }
  console.log(
    `Refreshing ${team.memberships.length} character(s) on team ${team.name}…`,
  );
  for (const m of team.memberships) {
    process.stdout.write(`  ${m.character.name}… `);
    try {
      await handleTrackedMemberSync({ characterId: m.characterId });
      console.log("ok");
    } catch (err) {
      console.log("FAILED:", err instanceof Error ? err.message : err);
    }
  }
  await db.raidTeam.update({
    where: { id: team.id },
    data: { lastRefreshAt: new Date() },
  });
  console.log("Done.");
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
