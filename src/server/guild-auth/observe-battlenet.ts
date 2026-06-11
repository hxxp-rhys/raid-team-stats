import { TRPCError } from "@trpc/server";

import { db } from "@/lib/db";
import { env } from "@/env";
import { normalizeRealmSlug, normalizeGuildSlug } from "@/lib/realm";
import type { VerifiedCharacterObservation } from "@/server/guild-auth/verify";

/**
 * Re-link guidance reused by every Battle.net-OAuth entry point. Battle.net
 * access tokens are short-lived (~24h) and the auth-code flow issues NO
 * refresh token, so a stored token simply goes stale. We surface that as an
 * actionable message rather than a raw "blizzard 401".
 */
const RELINK_MSG =
  "Your Battle.net sign-in has expired. On the Account page click " +
  "“Reconnect Battle.net”, then try again.";

/**
 * The expensive, OAuth-proven half of guild discovery, factored out so it can
 * be shared by THREE callers with different write semantics:
 *   - `guild.discoverFromBattlenet` (on-link auto-discover: observe + full
 *     applyVerification, including the absence sweep)
 *   - `guild.discoverGuildCandidates` (Add Guild lightbox step 1: observe +
 *     return candidates, ZERO writes)
 *   - `guild.addDiscoveredGuilds` (Add Guild lightbox step 2: observe again,
 *     then applyVerification over only the ticked guilds)
 *
 * SECURITY: the only trustworthy source of "which guilds may this user add"
 * is the caller's own Battle.net OAuth token. Both lightbox steps call THIS
 * function server-side; the client never supplies the observation set. The
 * add step uses the client's ticked list purely as a filter over what this
 * function independently re-derives.
 *
 * Cost per call: 1 userCharacters request (user OAuth) + N characterSummary
 * requests (one per character, app token) + G guildRoster requests (one per
 * distinct observed guild, app token, best-effort for rosterRank).
 */
export async function observeBattlenetGuilds(userId: string): Promise<{
  observations: VerifiedCharacterObservation[];
  charactersObserved: number;
}> {
  const account = await db.account.findFirst({
    where: { userId, provider: "battlenet" },
    select: { access_token: true, expires_at: true },
  });
  if (!account?.access_token) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Link your Battle.net account on the Account page first " +
        "(Link Battle.net).",
    });
  }
  if (
    typeof account.expires_at === "number" &&
    account.expires_at * 1000 <= Date.now() + 30_000
  ) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: RELINK_MSG });
  }

  const { blizzardClient } = await import("@/server/ingestion/blizzard/client");
  const { endpoints } = await import("@/server/ingestion/blizzard/endpoints");
  const {
    userCharactersResponseSchema,
    characterSummaryResponseSchema,
    guildRosterResponseSchema,
    FACTION_MAP,
  } = await import("@/server/ingestion/blizzard/schemas");

  const region = env.BLIZZARD_REGION;
  const client = blizzardClient();
  const characters = await client
    .request(endpoints.userCharacters(region), {
      region,
      schema: userCharactersResponseSchema,
      auth: { kind: "user", accessToken: account.access_token },
    })
    .catch((err: unknown) => {
      if (err instanceof Error && /\b401\b/.test(err.message)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: RELINK_MSG,
        });
      }
      throw err;
    });

  type Faction = "ALLIANCE" | "HORDE" | "NEUTRAL";
  const factionFromRaw = (raw: string | undefined, fallback: Faction): Faction =>
    raw ? ((FACTION_MAP[raw] ?? fallback) as Faction) : fallback;

  const observations: VerifiedCharacterObservation[] = [];
  for (const wowAccount of characters.wow_accounts) {
    for (const c of wowAccount.characters) {
      const realmSlug = normalizeRealmSlug(c.realm.slug);
      if (!realmSlug) continue;
      try {
        const summary = await client.request(
          endpoints.characterSummary(region, realmSlug, c.name),
          {
            region,
            schema: characterSummaryResponseSchema,
            auth: { kind: "app" },
          },
        );
        const charFaction = factionFromRaw(summary.faction?.type, "ALLIANCE");
        observations.push({
          blizzardCharacterId: c.id,
          region: region.toUpperCase() as "US" | "EU" | "KR" | "TW",
          realmSlug,
          characterName: c.name,
          faction: charFaction,
          level: summary.level ?? c.level ?? null,
          classId: summary.character_class?.id ?? c.playable_class?.id ?? null,
          race: undefined,
          guild: summary.guild
            ? {
                name: summary.guild.name,
                realmSlug: summary.guild.realm.slug,
                faction: factionFromRaw(summary.guild.faction?.type, charFaction),
                rosterRank: null,
              }
            : null,
        });
      } catch {
        // Skip transient per-character failures — picked up next sync.
      }
    }
  }

  // Battle.net's /profile/user/wow doesn't expose the user's rank within each
  // guild — only the guild's identity. To enable the rank-0 GM auto-claim
  // path, look up each distinct observed guild's roster (app credentials) and
  // patch the matching characters' rosterRank into the observations.
  type GuildKey = string;
  const guildKey = (g: { realmSlug: string; name: string }): GuildKey =>
    `${g.realmSlug}|${normalizeGuildSlug(g.name) ?? ""}`;
  const distinctGuilds = new Map<GuildKey, { realmSlug: string; name: string }>();
  for (const obs of observations) {
    if (!obs.guild) continue;
    distinctGuilds.set(guildKey(obs.guild), obs.guild);
  }

  const rankByCharacter = new Map<GuildKey, Map<string, number>>();
  for (const [key, g] of distinctGuilds) {
    const slug = normalizeGuildSlug(g.name);
    if (!slug) continue;
    try {
      const roster = await client.request(
        endpoints.guildRoster(region, g.realmSlug, slug),
        { region, schema: guildRosterResponseSchema, auth: { kind: "app" } },
      );
      const ranks = new Map<string, number>();
      for (const m of roster.members) {
        ranks.set(m.character.name.toLowerCase(), m.rank);
      }
      rankByCharacter.set(key, ranks);
    } catch {
      // Best-effort: without it, auto-claim won't fire for this guild but the
      // PENDING membership is still useful.
    }
  }

  for (const obs of observations) {
    if (!obs.guild) continue;
    const rank = rankByCharacter
      .get(guildKey(obs.guild))
      ?.get(obs.characterName.toLowerCase());
    if (typeof rank === "number") {
      obs.guild = { ...obs.guild, rosterRank: rank };
    }
  }

  return { observations, charactersObserved: observations.length };
}

/**
 * Stable opaque key for one candidate guild. The client receives this and
 * sends back only the keys it ticked; the server re-derives the full set via
 * `observeBattlenetGuilds` and treats the client list as a filter, so a
 * forged key is a no-op (it simply won't be in the re-derived set).
 *
 * Region is included because the Guild unique identity is
 * (region, realmSlug, guildSlug).
 */
export function candidateKey(
  region: string,
  guildRealmSlug: string,
  guildSlug: string,
): string {
  return `${region}|${guildRealmSlug}|${guildSlug}`;
}
