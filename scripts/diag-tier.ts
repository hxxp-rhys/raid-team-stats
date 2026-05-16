import { db } from "../src/lib/db";

async function main() {
  const eq = await db.equipmentSnapshot.findFirst({
    where: { tierSetPiecesCount: { gt: 0 } },
    orderBy: { capturedAt: "desc" },
    select: { tierSetPiecesCount: true, tierSetIds: true, items: true },
  });
  if (!eq) {
    console.log("no equipment snapshot with tier pieces");
    return;
  }
  console.log("tierSetPiecesCount:", eq.tierSetPiecesCount);
  console.log("tierSetIds:", JSON.stringify(eq.tierSetIds));
  const items = (eq.items as Array<Record<string, unknown>>) ?? [];
  // Print slot + set + level for each item that has a `set`.
  for (const it of items) {
    const slot = (it.slot as { type?: string })?.type;
    const set = (it.set as { item_set?: { id?: number; name?: string } })
      ?.item_set;
    const level = (it.level as { value?: number })?.value;
    if (set) {
      console.log(
        `slot=${slot} setId=${set.id} setName=${set.name} ilvl=${level}`,
      );
    }
  }
  // Show one full item shape (first with set) for field discovery.
  const sample = items.find((it) => (it.set as unknown) != null);
  if (sample) console.log("SAMPLE:", JSON.stringify(sample).slice(0, 900));
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
