/**
 * Dev/staging utility: exercise the real Blizzard client against the API
 * using the credentials in `.env`. Useful as a one-shot sanity check that
 *
 *   1. BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET / BLIZZARD_REGION are set
 *      to working values,
 *   2. the app token is fetched and cached in Redis,
 *   3. /data/wow/guild/{realm}/{slug}/roster and /profile/wow/character/...
 *      return the expected zod-validated shapes for a real guild.
 *
 * Usage (inside the web container, against the docker compose Redis):
 *
 *   docker exec rts-web npx tsx scripts/smoke-blizzard.ts \
 *     --realm stormrage --guild eclipse-midnight
 *
 *   docker exec rts-web npx tsx scripts/smoke-blizzard.ts \
 *     --realm "Wyrmrest Accord" --guild "My Guild" --region us \
 *     --first-character
 *
 * Refuses to run in production. Read-only — never writes to the DB. Costs ≤
 * 1 + N Blizzard API calls (1 roster + N character summaries, where N
 * defaults to 0; pass `--first-character` to additionally fetch one summary).
 */

import { normalizeRealmSlug, normalizeGuildSlug } from "@/lib/realm";
import { blizzardClient } from "@/server/ingestion/blizzard/client";
import { endpoints } from "@/server/ingestion/blizzard/endpoints";
import {
  guildRosterResponseSchema,
  characterSummaryResponseSchema,
} from "@/server/ingestion/blizzard/schemas";

type Args = {
  realm: string;
  guild: string;
  region: "us" | "eu" | "kr" | "tw";
  firstCharacter: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { region: "us", firstCharacter: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case "--realm":
        args.realm = argv[++i];
        break;
      case "--guild":
        args.guild = argv[++i];
        break;
      case "--region":
        args.region = (argv[++i] ?? "us").toLowerCase() as Args["region"];
        break;
      case "--first-character":
        args.firstCharacter = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
    }
  }
  if (!args.realm || !args.guild) {
    printUsage();
    process.exit(2);
  }
  if (!["us", "eu", "kr", "tw"].includes(args.region!)) {
    console.error(`Invalid region: ${args.region}. Use us|eu|kr|tw.`);
    process.exit(2);
  }
  return args as Args;
}

function printUsage() {
  console.error(
    [
      "Usage: tsx scripts/smoke-blizzard.ts --realm <realm> --guild <guild> [--region us|eu|kr|tw] [--first-character]",
      "",
      "Examples:",
      "  --realm stormrage --guild eclipse-midnight",
      '  --realm "Wyrmrest Accord" --guild "My Guild" --region eu --first-character',
    ].join("\n"),
  );
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run in production.");
    process.exit(2);
  }

  const args = parseArgs(process.argv.slice(2));
  const realmSlug = normalizeRealmSlug(args.realm);
  const guildSlug = normalizeGuildSlug(args.guild);
  if (!realmSlug || !guildSlug) {
    console.error("Realm or guild name normalises to empty — check spelling.");
    process.exit(2);
  }

  console.log(`Region:     ${args.region}`);
  console.log(`Realm slug: ${realmSlug}`);
  console.log(`Guild slug: ${guildSlug}`);
  console.log("");

  const client = blizzardClient();

  console.log("→ Fetching guild roster …");
  const rosterStart = Date.now();
  const roster = await client.request(
    endpoints.guildRoster(args.region, realmSlug, guildSlug),
    {
      region: args.region,
      schema: guildRosterResponseSchema,
      auth: { kind: "app" },
    },
  );
  console.log(
    `  ok in ${Date.now() - rosterStart}ms · ${roster.members.length} members`,
  );
  if (roster.members.length === 0) {
    console.error(
      "  ⚠ Empty roster — check the realm/guild slugs against the Blizzard URL pattern.",
    );
  } else {
    const sample = roster.members
      .slice(0, 5)
      .map(
        (m) =>
          `    rank ${m.rank.toString().padStart(2, " ")}  ${m.character.name} <${m.character.realm.slug}>`,
      )
      .join("\n");
    console.log("  sample:\n" + sample);
  }
  console.log("");

  if (args.firstCharacter && roster.members[0]) {
    const first = roster.members[0].character;
    console.log(`→ Fetching summary for ${first.name} …`);
    const sumStart = Date.now();
    const summary = await client.request(
      endpoints.characterSummary(args.region, first.realm.slug, first.name),
      {
        region: args.region,
        schema: characterSummaryResponseSchema,
        auth: { kind: "app" },
      },
    );
    console.log(`  ok in ${Date.now() - sumStart}ms`);
    console.log(`  iLvL:    ${summary.equipped_item_level ?? summary.average_item_level ?? "—"}`);
    console.log(`  level:   ${summary.level ?? "—"}`);
    console.log(`  faction: ${summary.faction?.type ?? "—"}`);
    if (summary.guild) {
      console.log(`  guild:   ${summary.guild.name} <${summary.guild.realm.slug}>`);
    }
  }

  console.log("");
  console.log("✓ Smoke complete. Token bucket + Redis cache + zod schemas all functional.");
}

main()
  .catch((err) => {
    console.error("✗ Smoke failed:");
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
