import { z, type ZodTypeAny } from "zod";

import { env } from "@/env";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { wclBucket } from "@/server/ingestion/rate-limit/token-bucket";

/**
 * Warcraft Logs v2 GraphQL client. Server-to-server only (client credentials).
 * Tracks point spend per hour in Redis against env.WCL_HOURLY_POINTS_BUDGET
 * so we never breach the Platinum-tier 18 000 points/hr limit.
 *
 * Auth: POST {issuer}/oauth/token with grant_type=client_credentials and
 * basic auth (client id + secret). Token expires; cached in Redis.
 */

const OAUTH_URL = "https://www.warcraftlogs.com/oauth/token";
const GRAPHQL_URL = "https://www.warcraftlogs.com/api/v2/client";

const TOKEN_REDIS_KEY = "wcl:app-token";
const POINTS_USED_KEY = (hourBucket: string) => `wcl:points:${hourBucket}`;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default("bearer"),
  expires_in: z.number().int().positive(),
});

// Top-level GraphQL response shape. `data` is the typed query payload;
// `extensions.rateLimitData` tells us the cost we just incurred so we can
// charge the per-hour bucket.
const graphqlEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(z.object({ message: z.string() }).passthrough())
    .optional(),
  extensions: z
    .object({
      rateLimitData: z
        .object({
          limitPerHour: z.number().int().nonnegative(),
          pointsSpentThisHour: z.number().nonnegative(),
          pointsResetIn: z.number().int().nonnegative(),
        })
        .partial()
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
});

type QueryOptions<S extends ZodTypeAny> = {
  query: string;
  variables?: Record<string, unknown>;
  schema: S;
  /** Conservative estimate of points this query will cost; used pre-flight to
   *  refuse work when the hourly budget is exhausted. Real cost is read from
   *  extensions.rateLimitData after the response. Default 1. */
  estimatedPoints?: number;
};

const hourBucket = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCHours()).padStart(2, "0")}`;
};

export class WarcraftLogsClient {
  /**
   * Execute a GraphQL query against the WCL v2 client endpoint.
   *
   * Throws on:
   * - Hourly point budget exceeded.
   * - WCL returns errors in the GraphQL envelope.
   * - Response data fails the supplied zod schema.
   */
  async query<S extends ZodTypeAny>(opts: QueryOptions<S>): Promise<z.infer<S>> {
    const estimatedCost = opts.estimatedPoints ?? 1;
    const bucket = hourBucket();
    const usedRaw = await redis.get(POINTS_USED_KEY(bucket));
    const used = usedRaw ? Number(usedRaw) : 0;
    if (used + estimatedCost > env.WCL_HOURLY_POINTS_BUDGET) {
      throw new Error(
        `wcl hourly points budget would be exceeded (used=${used}, est=${estimatedCost}, budget=${env.WCL_HOURLY_POINTS_BUDGET})`,
      );
    }

    // One token-bucket slot per outbound HTTP call; the points budget is
    // separate from the per-second smoothing the bucket gives us.
    await wclBucket.takeOrWait();

    const token = await this.getAppToken();
    let attempts = 0;
    for (;;) {
      attempts++;
      const res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query: opts.query, variables: opts.variables ?? {} }),
      });

      if (res.status === 401 && attempts === 1) {
        // Refresh token once and retry.
        await redis.del(TOKEN_REDIS_KEY);
        continue;
      }
      if (res.status === 429 && attempts <= 3) {
        const retry = Number(res.headers.get("retry-after") ?? "5");
        await new Promise((r) => setTimeout(r, retry * 1000));
        continue;
      }
      if (!res.ok) {
        throw new Error(`wcl ${res.status} ${res.statusText}`);
      }

      const envelope = graphqlEnvelopeSchema.parse(await res.json());
      if (envelope.errors && envelope.errors.length > 0) {
        throw new Error(`wcl graphql errors: ${envelope.errors.map((e) => e.message).join("; ")}`);
      }

      const spent = envelope.extensions?.rateLimitData?.pointsSpentThisHour;
      if (typeof spent === "number") {
        // Take the authoritative number from the server.
        await redis.set(POINTS_USED_KEY(bucket), spent.toString(), "EX", 3700);
      } else {
        // Fallback: charge the estimate so we always make forward progress.
        await redis.incrby(POINTS_USED_KEY(bucket), Math.max(1, estimatedCost));
        await redis.expire(POINTS_USED_KEY(bucket), 3700);
      }

      const parsed = opts.schema.safeParse(envelope.data);
      if (!parsed.success) {
        logger.error(
          { issues: parsed.error.issues.slice(0, 5) },
          "wcl response schema mismatch",
        );
        throw new Error("wcl response did not match schema");
      }
      return parsed.data;
    }
  }

  /**
   * Resolve the CURRENT RELEASE's WCL raid zone ids — the FULL set the app
   * tracks together. A release (e.g. 12.0) groups several raids; patches add
   * raids to it; only a `.release` bump replaces the set. So this is normally
   * MORE than one zone (e.g. Midnight 12.0.7 → [46, 50]).
   *
   * Priority:
   *   1. env.WCL_RAID_ZONE_ID — OPTIONAL emergency override (normally UNSET).
   *      If set it FORCES a single zone (reverts to single-tier tracking) and
   *      the worldData refresh job logs a loud drift WARNING.
   *   2. DB: the `WclZone` rows flagged `isCurrentRaid` (persisted by the job).
   *   3. Live `worldData` fallback (structural raid-difficulty detection) — the
   *      cold path before the job has populated the DB.
   *
   * Returns [] only when WCL is unreachable and nothing is pinned/stored.
   */
  async currentRaidZoneIds(): Promise<number[]> {
    const pinned = process.env.WCL_RAID_ZONE_ID;
    if (pinned && Number.isFinite(Number(pinned))) return [Number(pinned)];

    // Durable DB snapshot maintained by runWorldDataRefresh().
    try {
      const { db } = await import("@/lib/db");
      const rows = await db.wclZone.findMany({
        where: { isCurrentRaid: true },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      if (rows.length > 0) return rows.map((r) => r.id);
    } catch (err) {
      logger.warn(
        { err },
        "currentRaidZoneIds: DB read failed (falling back to live worldData)",
      );
    }

    // Cold fallback: resolve live from worldData using the structural
    // raid-difficulty signal (shared with the persistence job).
    try {
      const { WORLD_DATA_FULL_QUERY, worldDataFullResponseSchema } =
        await import("@/server/ingestion/warcraftlogs/queries");
      const { pickCurrentReleaseRaidZones } = await import(
        "@/server/ingestion/warcraftlogs/world-data"
      );
      const res = await this.query({
        query: WORLD_DATA_FULL_QUERY,
        schema: worldDataFullResponseSchema,
        estimatedPoints: 5,
      });
      const set = pickCurrentReleaseRaidZones(res.worldData?.zones ?? []);
      if (set.length > 0) {
        logger.info(
          { zoneIds: set.map((z) => z.id) },
          "resolved current WCL raid release (live fallback)",
        );
      }
      return set.map((z) => z.id);
    } catch (err) {
      logger.warn({ err }, "currentRaidZoneIds resolution failed");
      return [];
    }
  }

  /**
   * The single PRIMARY (newest) current-release raid zone id — for the few
   * callers that genuinely need one zone (a default / seed). Most current-tier
   * reads should use `currentRaidZoneIds()` so they cover the whole release.
   */
  async currentRaidZoneId(): Promise<number | null> {
    const ids = await this.currentRaidZoneIds();
    return ids.length > 0 ? Math.max(...ids) : null;
  }

  /**
   * The merged boss list across ALL current-release raid zones, each encounter
   * tagged with its `zoneId` — so a widget can show every boss in the release
   * (grouped by zone) and filter parses to the release set. Reads each zone's
   * persisted `WclZone.encounters` (DB-first, via currentRaidZoneEncounters).
   */
  async currentReleaseEncounters(
    zoneIds: number[],
  ): Promise<Array<{ id: number; name: string; zoneId: number }>> {
    const out: Array<{ id: number; name: string; zoneId: number }> = [];
    for (const zid of zoneIds) {
      const enc = await this.currentRaidZoneEncounters(zid);
      for (const e of enc) out.push({ ...e, zoneId: zid });
    }
    return out;
  }

  /**
   * The CURRENT raid tier's encounter (boss) list — WCL encounter id + name
   * for the live zone. Lets widgets seed their legend with EVERY boss so a
   * brand-new encounter (e.g. a freshly-released raid like Sporefall/Rotmire)
   * shows as a column even before anyone in the guild has a parse on it.
   *
   * Static per content patch → cached in Redis keyed by zone id. A non-empty
   * result is cached 7 days; an empty one only 5 min, so a transient WCL
   * failure can't hide the boss list for a week. Never throws → [] on any
   * failure (caller falls back to deriving the list from stored parses).
   *
   * `zoneId` may be passed by a caller that already resolved it (avoids a
   * second `currentRaidZoneId()` call); otherwise it's resolved here.
   */
  async currentRaidZoneEncounters(
    zoneId?: number | null,
  ): Promise<Array<{ id: number; name: string }>> {
    const zid = zoneId ?? (await this.currentRaidZoneId());
    if (zid == null) return [];

    // 1. Durable DB snapshot (the worldData refresh persists every zone's boss
    //    list) — survives a Redis flush; no WCL call on the hot path.
    try {
      const { db } = await import("@/lib/db");
      const row = await db.wclZone.findUnique({
        where: { id: zid },
        select: { encounters: true },
      });
      const enc = row?.encounters;
      if (Array.isArray(enc) && enc.length > 0) {
        return (enc as Array<{ id: number; name?: string }>).map((e) => ({
          id: e.id,
          name: e.name ?? `Encounter ${e.id}`,
        }));
      }
    } catch (err) {
      logger.warn(
        { err, zid },
        "zone-encounters: DB read failed (falling back to cache/live)",
      );
    }

    const CACHE_KEY = `wcl:zone-encounters:${zid}`;
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) return JSON.parse(cached) as Array<{ id: number; name: string }>;
    } catch (err) {
      logger.warn({ err, zid }, "zone-encounters: redis get failed (continuing)");
    }

    let encounters: Array<{ id: number; name: string }> = [];
    try {
      const { ZONE_ENCOUNTERS_QUERY, wclZoneEncountersResponseSchema } =
        await import("@/server/ingestion/warcraftlogs/queries");
      const res = await this.query({
        query: ZONE_ENCOUNTERS_QUERY,
        variables: { zoneID: zid },
        schema: wclZoneEncountersResponseSchema,
        estimatedPoints: 2,
      });
      encounters = (res.worldData?.zone?.encounters ?? [])
        .filter((e): e is NonNullable<typeof e> => e != null)
        .map((e) => ({ id: e.id, name: e.name ?? `Encounter ${e.id}` }));
    } catch (err) {
      logger.warn({ err, zid }, "zone-encounters: WCL fetch failed");
    }

    try {
      await redis.set(
        CACHE_KEY,
        JSON.stringify(encounters),
        "EX",
        encounters.length > 0 ? 7 * 24 * 60 * 60 : 300,
      );
    } catch (err) {
      logger.warn({ err, zid }, "zone-encounters: redis set failed (continuing)");
    }
    return encounters;
  }

  private async getAppToken(): Promise<string> {
    const cached = await redis.get(TOKEN_REDIS_KEY);
    if (cached) return cached;

    if (!env.WCL_CLIENT_ID || !env.WCL_CLIENT_SECRET) {
      throw new Error("WCL_CLIENT_ID / WCL_CLIENT_SECRET are not set");
    }

    const basic = Buffer.from(
      `${env.WCL_CLIENT_ID}:${env.WCL_CLIENT_SECRET}`,
    ).toString("base64");
    const res = await fetch(OAUTH_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    if (!res.ok) {
      throw new Error(`wcl token request failed: ${res.status} ${res.statusText}`);
    }
    const parsed = tokenResponseSchema.parse(await res.json());
    const ttlSec = Math.max(60, parsed.expires_in - 30 * 60);
    await redis.set(TOKEN_REDIS_KEY, parsed.access_token, "EX", ttlSec);
    return parsed.access_token;
  }
}

let _client: WarcraftLogsClient | null = null;
export const warcraftLogsClient = (): WarcraftLogsClient => {
  if (!_client) _client = new WarcraftLogsClient();
  return _client;
};
