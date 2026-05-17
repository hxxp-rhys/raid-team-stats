/**
 * E2E helper for the addon-upload pipeline.
 *   node --env-file=.env --import tsx scripts/diag-addon-e2e.ts set
 *     -> sets a temporary uploadToken on the user owning an Eclipse char,
 *        prints TOKEN + that character's name/realm/region (for crafting
 *        a test payload to POST through Cloudflare).
 *   ... verify    -> prints the AddonUpload row for that character.
 *   ... clear     -> nulls the temporary token (cleanup).
 */
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/db";

async function pickChar() {
  const team = await db.raidTeam.findFirst({
    where: { name: { contains: "Eclipse", mode: "insensitive" } },
    select: {
      memberships: {
        where: { isActive: true },
        take: 1,
        select: {
          character: {
            select: {
              id: true,
              name: true,
              realmSlug: true,
              region: true,
              userId: true,
            },
          },
        },
      },
    },
  });
  return team?.memberships[0]?.character ?? null;
}

async function main() {
  const mode = process.argv[2] ?? "set";
  const c = await pickChar();
  if (!c) {
    console.log("no eclipse character found");
    await db.$disconnect();
    return;
  }
  if (mode === "set") {
    const token = "e2e_" + randomBytes(20).toString("hex");
    await db.user.update({
      where: { id: c.userId },
      data: { uploadToken: token },
    });
    console.log(
      JSON.stringify({
        TOKEN: token,
        name: c.name,
        realm: c.realmSlug,
        region: c.region.toLowerCase(),
        characterId: c.id,
      }),
    );
  } else if (mode === "verify") {
    const up = await db.addonUpload.findUnique({
      where: { characterId: c.id },
      select: {
        worldUnlocked: true,
        worldTotal: true,
        raidUnlocked: true,
        mplusUnlocked: true,
        weeklyMplusRuns: true,
        collectedAt: true,
        receivedAt: true,
        addonVersion: true,
      },
    });
    console.log(c.name, "AddonUpload =", JSON.stringify(up));
  } else if (mode === "clear") {
    await db.user.update({
      where: { id: c.userId },
      data: { uploadToken: null },
    });
    console.log("cleared temporary uploadToken for", c.name);
  } else if (mode === "purge") {
    await db.addonUpload.deleteMany({ where: { characterId: c.id } });
    console.log("purged synthetic AddonUpload for", c.name);
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
