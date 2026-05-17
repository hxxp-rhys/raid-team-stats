/**
 * Enqueue a Tier-A sync for every active Eclipse member onto the BullMQ
 * queue so the running worker processes them with its real rate-limit /
 * concurrency infrastructure (the inline force-refresh stalls on the
 * Redis token-bucket when run outside the worker).
 *
 *   node --env-file=.env --import tsx scripts/enqueue-eclipse-refresh.ts
 */
import { db } from "../src/lib/db";
import { queues, QUEUE_NAMES } from "../src/server/ingestion/queues";

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
    await db.$disconnect();
    return;
  }
  const stamp = Date.now();
  await queues.trackedMemberSync.addBulk(
    team.memberships.map((m) => ({
      name: QUEUE_NAMES.trackedMemberSync,
      data: { characterId: m.characterId },
      opts: { jobId: `manual_${m.characterId}_${stamp}` },
    })),
  );
  await db.raidTeam.update({
    where: { id: team.id },
    data: { lastRefreshAt: new Date() },
  });
  console.log(
    `Enqueued ${team.memberships.length} Tier-A job(s) for ${team.name}: ` +
      team.memberships.map((m) => m.character.name).join(", "),
  );
  await db.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
