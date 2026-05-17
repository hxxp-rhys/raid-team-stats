/**
 * Read-only status of the addon-upload pipeline:
 *   - users that have generated an upload token
 *   - every AddonUpload row (real companion uploads) with derived data
 *
 *   node --env-file=.env --import tsx scripts/diag-addon-status.ts
 */
import { db } from "../src/lib/db";

async function main() {
  const tokenUsers = await db.user.count({
    where: { uploadToken: { not: null } },
  });
  const uploads = await db.addonUpload.findMany({
    orderBy: { receivedAt: "desc" },
    select: {
      collectedAt: true,
      receivedAt: true,
      addonVersion: true,
      worldUnlocked: true,
      worldTotal: true,
      raidUnlocked: true,
      mplusUnlocked: true,
      weeklyMplusRuns: true,
      character: { select: { name: true, realmSlug: true, region: true } },
      user: { select: { email: true } },
    },
  });

  console.log(`users with an upload token: ${tokenUsers}`);
  console.log(`AddonUpload rows: ${uploads.length}`);
  for (const u of uploads) {
    console.log(
      `- ${u.character.name}-${u.character.realmSlug} (${u.character.region}) ` +
        `world=${u.worldUnlocked}/${u.worldTotal} raid=${u.raidUnlocked} ` +
        `mplus=${u.mplusUnlocked} wkRuns=${u.weeklyMplusRuns} ` +
        `addon=${u.addonVersion} collected=${u.collectedAt.toISOString()} ` +
        `received=${u.receivedAt.toISOString()} by=${u.user.email}`,
    );
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
