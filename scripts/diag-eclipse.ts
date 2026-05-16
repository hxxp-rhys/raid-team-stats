import { db } from "../src/lib/db";

async function main() {
  const teams = await db.raidTeam.findMany({
    where: { name: { contains: "Eclipse", mode: "insensitive" } },
    include: {
      memberships: {
        where: { isActive: true },
        include: {
          character: {
            select: {
              id: true,
              name: true,
              level: true,
              userId: true,
              user: { select: { email: true } },
              _count: {
                select: {
                  characterSnapshots: true,
                  equipmentSnapshots: true,
                  mplusSnapshots: true,
                  raidSnapshots: true,
                  vaultSnapshots: true,
                  wclParseSnapshots: true,
                },
              },
            },
          },
        },
      },
      guild: { select: { id: true, name: true, claimedByUserId: true } },
      _count: { select: { dashboards: true } },
    },
  });
  for (const t of teams) {
    console.log(`Team: ${t.name} (id=${t.id}) guild=${t.guild.name}`);
    console.log(`  leaderUserId=${t.leaderUserId} pendingLeaderChar=${t.pendingLeaderCharacterId ?? "—"}`);
    console.log(`  dashboards=${t._count.dashboards} activeMembers=${t.memberships.length}`);
    for (const m of t.memberships.slice(0, 5)) {
      console.log(
        `    - ${m.character.name} L${m.character.level} owner=${m.character.user.email}` +
          ` snap[char=${m.character._count.characterSnapshots} eq=${m.character._count.equipmentSnapshots} mplus=${m.character._count.mplusSnapshots} raid=${m.character._count.raidSnapshots} vault=${m.character._count.vaultSnapshots} wcl=${m.character._count.wclParseSnapshots}]`,
      );
    }
    if (t.memberships.length > 5) console.log(`    ... +${t.memberships.length - 5} more`);
  }
  const ds = await db.dashboardConfig.findMany({
    where: { raidTeam: { name: { contains: "Eclipse", mode: "insensitive" } } },
    select: {
      id: true,
      name: true,
      slug: true,
      raidTeamId: true,
      ownerUserId: true,
      layout: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
  console.log(`\nDashboards (${ds.length}):`);
  for (const d of ds) {
    const layout = d.layout as { version?: number; tabs?: Array<{ widgets: unknown[] }> };
    const widgetCount = (layout.tabs ?? []).reduce(
      (acc, t) => acc + (t.widgets?.length ?? 0),
      0,
    );
    console.log(
      `  ${d.name} (id=${d.id}) owner=${d.ownerUserId} widgets=${widgetCount} createdAt=${d.createdAt.toISOString()}`,
    );
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
