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
      select: { rawPayload: true, runsThisWeek: true, weeklyHighest: true },
    });
    if (!m) continue;
    const rp = m.rawPayload as {
      index?: {
        current_period?: { best_runs?: unknown[]; period?: { id?: number } };
      };
      season?: { best_runs?: unknown[] };
    };
    const cp = rp?.index?.current_period;
    const seasonRuns = rp?.season?.best_runs?.length ?? 0;
    const periodRuns = cp?.best_runs?.length ?? 0;
    const stored = Array.isArray(m.runsThisWeek)
      ? (m.runsThisWeek as unknown[]).length
      : null;
    console.log(
      `${mem.character.name}: storedRuns=${stored} season.best_runs=${seasonRuns} current_period.best_runs=${periodRuns} periodId=${cp?.period?.id} weeklyHighest=${m.weeklyHighest}`,
    );
    if (cp?.best_runs && periodRuns > 0) {
      console.log(
        "  current_period sample:",
        JSON.stringify(cp.best_runs[0]).slice(0, 300),
      );
    }
  }
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
