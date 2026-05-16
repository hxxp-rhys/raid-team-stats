import { db } from "../src/lib/db";

async function main() {
  const m = await db.mplusSnapshot.findFirst({
    orderBy: { capturedAt: "desc" },
    select: { runsThisWeek: true, weeklyHighest: true },
  });
  console.log("MPLUS runsThisWeek:", JSON.stringify(m?.runsThisWeek)?.slice(0, 800));
  console.log("MPLUS weeklyHighest:", m?.weeklyHighest);
  const r = await db.raidSnapshot.findFirst({
    orderBy: { capturedAt: "desc" },
    select: { completions: true },
  });
  console.log("RAID completions:", JSON.stringify(r?.completions)?.slice(0, 800));
  const v = await db.vaultSnapshot.findFirst({
    orderBy: { capturedAt: "desc" },
    select: { slots: true },
  });
  console.log("VAULT slots:", JSON.stringify(v?.slots));
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
