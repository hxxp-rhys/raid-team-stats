import { logger } from "@/lib/logger";
import { WowauditClient } from "@/server/ingestion/wowaudit/client";
import type { WowauditCharacter } from "@/server/ingestion/wowaudit/schemas";
import {
  extractWorldVault,
  normalizeName,
  normalizeRealm,
  type WorldVault,
} from "@/server/ingestion/wowaudit/vault";

/**
 * Resolves the World (Delve) Great Vault row for a tracked character from
 * its guild's WoW Audit integration. Blizzard exposes no World/Delve vault
 * API, so WoW Audit (fed by its in-game companion addon) is the only
 * source. Dormant until a guild configures a WoW Audit API key.
 *
 * Tier-A processes characters one job at a time; fetching the full
 * `/characters` roster per character would be wasteful and rate-limit
 * heavy, so the roster is memoised per guild for a short TTL.
 */

const CACHE_TTL_MS = 5 * 60_000;

type CacheEntry = { at: number; chars: WowauditCharacter[] | null };
const rosterCache = new Map<string, CacheEntry>();

async function getGuildRoster(
  guildId: string,
): Promise<WowauditCharacter[] | null> {
  const cached = rosterCache.get(guildId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.chars;

  let chars: WowauditCharacter[] | null = null;
  try {
    const client = await WowauditClient.forGuild(guildId);
    if (client) chars = await client.getCharacters();
  } catch (err) {
    // Soft-fail: a WoW Audit outage / bad key must never break the rest of
    // the sync. World row simply stays untracked until it recovers.
    logger.warn({ err, guildId }, "wowaudit roster fetch failed");
    chars = null;
  }
  rosterCache.set(guildId, { at: Date.now(), chars });
  return chars;
}

/**
 * Returns the World vault row for the given character, or null when WoW
 * Audit isn't configured for the guild / the character isn't found / no
 * usable signal — in which case the caller keeps `tracked:false`.
 */
export async function resolveWorldVault(args: {
  guildId: string;
  name: string;
  realmSlug: string;
}): Promise<WorldVault | null> {
  const roster = await getGuildRoster(args.guildId);
  if (!roster || roster.length === 0) return null;

  const wantName = normalizeName(args.name);
  const wantRealm = normalizeRealm(args.realmSlug);

  // Prefer an exact name+realm match; fall back to a unique name match
  // (WoW Audit `realm` is a display name, ours is a slug — normalize both).
  const byName = roster.filter((c) => normalizeName(c.name) === wantName);
  const match =
    byName.find(
      (c) => c.realm && normalizeRealm(c.realm) === wantRealm,
    ) ?? (byName.length === 1 ? byName[0] : undefined);
  if (!match) return null;

  return extractWorldVault(match);
}
