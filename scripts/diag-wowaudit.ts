import { db } from "../src/lib/db";

async function main() {
  const g = await db.guild.findMany({
    select: { name: true, wowauditApiKey: true, wowauditTeamId: true },
  });
  console.log(
    JSON.stringify(
      g.map((x) => ({
        name: x.name,
        hasWoWAuditKey: !!x.wowauditApiKey,
        teamId: x.wowauditTeamId ?? null,
      })),
    ),
  );
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
