/**
 * Verify the WoW Audit World-vault integration once a guild has a key set.
 *
 *   node --env-file=.env --import tsx scripts/diag-wowaudit-vault.ts
 *
 * For every guild with a WoW Audit key configured it fetches /v1/characters,
 * prints the raw great_vault_slot_* + delve_info for the first few rows, and
 * shows what extractWorldVault() derives. Use this to confirm the slot
 * mapping against the live API instead of guessing.
 */
import { db } from "../src/lib/db";
import { WowauditClient } from "../src/server/ingestion/wowaudit/client";
import { extractWorldVault } from "../src/server/ingestion/wowaudit/vault";

async function main() {
  const guilds = await db.guild.findMany({
    where: { wowauditApiKey: { not: null } },
    select: { id: true, name: true },
  });
  if (guilds.length === 0) {
    console.log("No guild has a WoW Audit API key configured yet.");
    await db.$disconnect();
    return;
  }

  for (const g of guilds) {
    console.log(`\n=== Guild: ${g.name} (${g.id}) ===`);
    const client = await WowauditClient.forGuild(g.id);
    if (!client) {
      console.log("  (config could not be decrypted)");
      continue;
    }
    try {
      const chars = await client.getCharacters();
      console.log(`  ${chars.length} characters returned.`);
      for (const c of chars.slice(0, 5)) {
        const rec = c as unknown as Record<string, unknown>;
        const slots = Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [
            `slot_${i + 1}`,
            rec[`great_vault_slot_${i + 1}`] ?? null,
          ]),
        );
        console.log(
          `  - ${c.name} @ ${c.realm ?? "?"} :: world=${JSON.stringify(
            extractWorldVault(c),
          )} slots=${JSON.stringify(slots)} delve_info=${JSON.stringify(
            c.delve_info ?? null,
          )}`,
        );
      }
    } catch (err) {
      console.log(
        `  FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
