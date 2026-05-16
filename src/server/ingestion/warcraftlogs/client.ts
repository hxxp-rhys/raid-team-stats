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
