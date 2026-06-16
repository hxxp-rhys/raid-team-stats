import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { blizzardClient } from "@/server/ingestion/blizzard/client";
import { endpoints, defaultRegion } from "@/server/ingestion/blizzard/endpoints";
import {
  journalInstanceMediaResponseSchema,
  journalInstanceResponseSchema,
} from "@/server/ingestion/blizzard/schemas";

/**
 * Resolves the official tile/background art URL for a raid's Blizzard
 * journal-instance, for the calendar's zone-targeted day backgrounds.
 *
 * The media (assets[].{key,value}) is STATIC per patch + identical for
 * everyone, so the resolved URL is cached in Redis with a 7-day TTL (mirrors
 * the prof-cat: pattern). On any failure (instance not in the static map,
 * media 404 for a not-yet-released tier, fetch error) → null, and the calendar
 * cell falls back to its difficulty-tinted styling. NEVER throws.
 */

const TTL_SECONDS = 7 * 24 * 60 * 60;
// A distinct cache value meaning "we resolved this and there's no tile" so a
// 404 zone doesn't re-hit Blizzard on every request for a week.
const NONE = "__none__";
const key = (region: string, instanceId: number) =>
  `zone-art:${region.toLowerCase()}:${instanceId}`;

/**
 * The current-tier raid zone NAME → Blizzard journal-instance id map. The WCL
 * zone-name → Blizzard-art mapping needs this static table because WCL combines
 * zones (e.g. zone 46 = "VS / DR / MQD") and uses its own ids. Update on each
 * content patch.
 */
export const CURRENT_TIER_INSTANCES: Record<string, number> = {
  "The Voidspire": 1307,
  "March on Quel'Danas": 1308,
  "The Dreamrift": 1314,
  // 12.0.7 "Sporefall" (WCL zone 50, single boss "Rotmire") is live, but its
  // Blizzard journal-instance is NOT yet published in the static game-data API
  // (verified by scanning /data/wow/journal-instance on patch day). Add
  // `"Sporefall": <id>` here once it appears; until then the calendar just shows
  // no custom art/boss-list for it (getZoneArtUrl/getZoneEncounters degrade to
  // null/[] gracefully).
};

/**
 * Resolve a journal-instance's hi-res tile URL (null when none/unavailable).
 * `size` swaps the `-small.jpg` suffix for `-large.jpg` when "large".
 */
export async function getZoneArtUrl(
  instanceId: number,
  opts?: { region?: string; size?: "small" | "large" },
): Promise<string | null> {
  const region = opts?.region ?? defaultRegion();
  const size = opts?.size ?? "large";
  const k = key(region, instanceId);

  try {
    const cached = await redis.get(k);
    if (cached !== null) {
      const base = cached === NONE ? null : cached;
      return base ? withSize(base, size) : null;
    }
  } catch (err) {
    logger.warn({ err, k }, "zone-art: redis get failed (continuing)");
  }

  let tile: string | null = null;
  try {
    const res = await blizzardClient().request(
      endpoints.journalInstanceMedia(region, instanceId),
      {
        region,
        schema: journalInstanceMediaResponseSchema,
        auth: { kind: "app" },
        minFloor: 0,
      },
    );
    tile =
      (res.assets ?? []).find((a) => a.key === "tile")?.value ??
      // fall back to the first asset with a value if "tile" is absent
      (res.assets ?? []).find((a) => typeof a.value === "string")?.value ??
      null;
  } catch (err) {
    // 404 for an unreleased tier (e.g. Sporefall pre-12.0.7) lands here — cache
    // the miss so we don't re-fetch for a week, then return null.
    logger.warn({ err, region, instanceId }, "zone-art: media fetch failed");
  }

  try {
    // Cache the resolved BASE (small) url, or the NONE sentinel on a miss.
    await redis.set(k, tile ?? NONE, "EX", TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, k }, "zone-art: redis set failed (continuing)");
  }
  return tile ? withSize(tile, size) : null;
}

/** Swap the render.worldofwarcraft.com tile suffix to the requested size. */
function withSize(url: string, size: "small" | "large"): string {
  if (size === "small") return url;
  return url.replace(/-small\.jpg$/i, "-large.jpg");
}

/** Normalize a Blizzard name (string, or a localized { en_US: … } object). */
function nameOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, string>;
    return o.en_US ?? Object.values(o)[0] ?? null;
  }
  return null;
}

export type ZoneEncounter = { id: number; name: string };

/**
 * The encounters (bosses) of a raid's Blizzard journal-instance — the
 * per-raid boss list the calendar's target picker needs (WCL's combined tier
 * zone can't separate the raids). Static per patch, so cached in Redis 7 days.
 * Returns [] (never throws) when the instance isn't released yet / on error.
 */
export async function getZoneEncounters(
  instanceId: number,
  opts?: { region?: string },
): Promise<ZoneEncounter[]> {
  const region = opts?.region ?? defaultRegion();
  const k = `zone-enc:${region.toLowerCase()}:${instanceId}`;

  try {
    const cached = await redis.get(k);
    if (cached !== null) return JSON.parse(cached) as ZoneEncounter[];
  } catch (err) {
    logger.warn({ err, k }, "zone-enc: redis get failed (continuing)");
  }

  let encounters: ZoneEncounter[] = [];
  try {
    const res = await blizzardClient().request(
      endpoints.journalInstance(region, instanceId),
      {
        region,
        schema: journalInstanceResponseSchema,
        auth: { kind: "app" },
        minFloor: 0,
      },
    );
    encounters = (res.encounters ?? [])
      .filter((e): e is NonNullable<typeof e> => e != null)
      .map((e) => ({ id: e.id, name: nameOf(e.name) ?? `Boss ${e.id}` }));
  } catch (err) {
    logger.warn({ err, region, instanceId }, "zone-enc: fetch failed");
  }

  try {
    await redis.set(k, JSON.stringify(encounters), "EX", TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, k }, "zone-enc: redis set failed (continuing)");
  }
  return encounters;
}
