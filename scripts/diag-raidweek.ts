import { db } from "../src/lib/db";

function currentWeekStartMs(now: number): number {
  const d = new Date(now);
  const daysSinceTue = (d.getDay() - 2 + 7) % 7;
  const tue = new Date(d);
  tue.setDate(d.getDate() - daysSinceTue);
  tue.setHours(12, 0, 0, 0);
  if (tue.getTime() > now) tue.setDate(tue.getDate() - 7);
  return tue.getTime();
}

async function main() {
  const weekStart = currentWeekStartMs(Date.now());
  console.log("weekStart:", new Date(weekStart).toISOString());
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
    const r = await db.raidSnapshot.findFirst({
      where: { characterId: mem.character.id, source: "BLIZZARD" },
      orderBy: { capturedAt: "desc" },
      select: { completions: true },
    });
    const comps = Array.isArray(r?.completions)
      ? (r!.completions as Array<{
          difficultyType?: string;
          encounters?: Array<{ kills?: number; lastKillTimestamp?: number | null }>;
        }>)
      : [];
    const lifetime: Record<string, number> = {};
    const thisWeek: Record<string, number> = {};
    let hasTs = 0;
    let noTs = 0;
    for (const e of comps) {
      const diff = (e.difficultyType ?? "?").toUpperCase();
      for (const b of e.encounters ?? []) {
        if ((b.kills ?? 0) <= 0) continue;
        lifetime[diff] = (lifetime[diff] ?? 0) + 1;
        if (typeof b.lastKillTimestamp === "number") {
          hasTs++;
          if (b.lastKillTimestamp >= weekStart)
            thisWeek[diff] = (thisWeek[diff] ?? 0) + 1;
        } else {
          noTs++;
        }
      }
    }
    console.log(
      `${mem.character.name}: lifetime=${JSON.stringify(lifetime)} thisWeek=${JSON.stringify(thisWeek)} (ts present=${hasTs} missing=${noTs})`,
    );
  }
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
