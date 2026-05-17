/**
 * Validate enchantable/socketable slots against LIVE WoW Midnight data.
 * Dumps every equipped item's slot + whether Blizzard reports an
 * enchantment / sockets for the Eclipse roster (well-geared Mythic
 * raiders → if a slot is enchantable this expansion, theirs will show it).
 *
 *   node --env-file=.env --import tsx scripts/diag-gear-slots.ts
 */
import { db } from "../src/lib/db";

type Item = {
  slot?: { type?: string };
  name?: string;
  enchantments?: unknown[];
  sockets?: Array<{ item?: unknown }>;
};

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
  const ids = team?.memberships.map((m) => m.character.id) ?? [];
  const enchantedSlots = new Set<string>();
  const socketedSlots = new Set<string>();
  for (const id of ids) {
    const snap = await db.equipmentSnapshot.findFirst({
      where: { characterId: id, source: "BLIZZARD" },
      orderBy: { capturedAt: "desc" },
      select: { items: true },
    });
    const name =
      team?.memberships.find((m) => m.character.id === id)?.character.name ??
      id;
    const items = (Array.isArray(snap?.items) ? snap?.items : []) as Item[];
    console.log(`\n### ${name} (${items.length} items)`);
    for (const it of items) {
      const slot = it.slot?.type ?? "?";
      const ench = (it.enchantments?.length ?? 0) > 0;
      const socks = it.sockets?.length ?? 0;
      const filled = it.sockets?.filter((s) => s.item).length ?? 0;
      if (ench) enchantedSlots.add(slot);
      if (socks > 0) socketedSlots.add(slot);
      console.log(
        `  ${slot.padEnd(12)} ench=${ench ? "Y" : "."} sockets=${filled}/${socks}`,
      );
    }
  }
  console.log(
    `\nSlots that ACTUALLY carry an enchant in live data: ${[...enchantedSlots].sort().join(", ")}`,
  );
  console.log(
    `Slots that have sockets in live data: ${[...socketedSlots].sort().join(", ")}`,
  );
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
