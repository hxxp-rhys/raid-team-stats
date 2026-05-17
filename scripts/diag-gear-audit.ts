/**
 * Show the Midnight-correct gear audit (computeGearAudit) for the Eclipse
 * roster from stored equipment snapshots — confirms Wrist/Back are no
 * longer false-flagged and Head/Shoulder are now checked.
 *
 *   node --env-file=.env --import tsx scripts/diag-gear-audit.ts
 */
import { db } from "../src/lib/db";
import { computeGearAudit } from "../src/server/ingestion/gear-audit";

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
  for (const m of team?.memberships ?? []) {
    const snap = await db.equipmentSnapshot.findFirst({
      where: { characterId: m.character.id, source: "BLIZZARD" },
      orderBy: { capturedAt: "desc" },
      select: { items: true },
    });
    const a = computeGearAudit(snap?.items);
    console.log(
      `${m.character.name}: enchants ${a.missingEnchantsCount} [${a.missingEnchantSlots.join(", ")}]  gems ${a.missingGemsCount} [${a.missingGemSlots.join(", ")}]`,
    );
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
