import type { ZodTypeAny, z } from "zod";

import { env } from "@/env";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { blizzardBucket } from "@/server/ingestion/rate-limit/token-bucket";
import {
  battleNetOAuthBase,
  blizzardApiBase,
  type BlizzardPath,
  defaultRegion,
} from "@/server/ingestion/blizzard/endpoints";
import { appTokenResponseSchema } from "@/server/ingestion/blizzard/schemas";

/**
 * Region-aware Blizzard REST client. App-token caching, token-bucket rate
 * limiting, and 401/429 retries are all centralized here so individual
 * endpoint helpers stay declarative.
 *
 * Auth modes:
 *  - "app": client_credentials token cached in Redis. Used for guild roster,
 *    character summary, character equipment — anything publicly addressable.
 *  - "user": OAuth user token (Account.access_token). Used for
 *    /profile/user/wow. The caller supplies the token.
 *
 * Class reservations (`minFloor`): tier-B/C bulk callers reserve room so the
 * tier-A and interactive paths always have headroom. See token-bucket.ts.
 */

type AuthMode =
  | { kind: "app" }
  | { kind: "user"; accessToken: string };

type RequestOptions<S extends ZodTypeAny> = {
  region?: string;
  schema: S;
  auth: AuthMode;
  /** Token-bucket minFloor — pass non-zero for bulk callers. */
  minFloor?: number;
  /** Extra query params beyond the implicit namespace + locale. */
  query?: Record<string, string | number | undefined>;
  /** Custom timeout. */
  timeoutMs?: number;
};

const APP_TOKEN_REDIS_KEY = (region: string) => `bnet:app-token:${region.toLowerCase()}`;
const DEFAULT_TIMEOUT_MS = 15_000;

export class BlizzardClient {
  /**
   * Fetches and zod-validates a Blizzard endpoint. Throws on non-2xx after
   * retries, on schema mismatch, or on token-bucket starvation.
   */
  async request<S extends ZodTypeAny>(
    path: BlizzardPath,
    options: RequestOptions<S>,
  ): Promise<z.infer<S>> {
    const region = options.region ?? defaultRegion();

    // Reserve a bucket slot before issuing.
    await blizzardBucket.takeOrWait({ minFloor: options.minFloor ?? 0 });

    const url = this.buildUrl(region, path, options.query);
    const headers = await this.buildHeaders(region, options.auth);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: controller.signal });
    } catch (err) {
      throw wrap(err, "blizzard fetch failed", { url });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 && options.auth.kind === "app") {
      // App token may have expired — invalidate cache and try once more.
      await redis.del(APP_TOKEN_REDIS_KEY(region));
      const retryHeaders = await this.buildHeaders(region, options.auth);
      res = await fetch(url, { headers: retryHeaders });
    }

    if (res.status === 429) {
      const retryAfterSec = Number(res.headers.get("retry-after") ?? "5");
      logger.warn({ url, retryAfterSec }, "blizzard 429; backing off");
      await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
      const retried = await fetch(url, { headers });
      if (!retried.ok) {
        throw new Error(`blizzard 429-retry still failed: ${retried.status}`);
      }
      res = retried;
    }

    if (!res.ok) {
      throw new Error(`blizzard ${res.status} ${res.statusText} for ${path.path}`);
    }

    const json = await res.json();
    const parsed = options.schema.safeParse(json);
    if (!parsed.success) {
      logger.error(
        { url, issues: parsed.error.issues.slice(0, 5) },
        "blizzard response schema mismatch",
      );
      throw new Error(`blizzard response did not match schema for ${path.path}`);
    }
    return parsed.data;
  }

  private buildUrl(
    region: string,
    path: BlizzardPath,
    extraQuery?: Record<string, string | number | undefined>,
  ): string {
    const url = new URL(path.path, blizzardApiBase(region));
    url.searchParams.set("namespace", path.namespace);
    url.searchParams.set("locale", "en_US");
    if (extraQuery) {
      for (const [k, v] of Object.entries(extraQuery)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async buildHeaders(region: string, auth: AuthMode): Promise<HeadersInit> {
    const token = auth.kind === "app" ? await this.getAppToken(region) : auth.accessToken;
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "raid-team-stats/0.1 (+https://github.com/hxxp-rhys/raid-stats)",
    };
  }

  /**
   * Acquires (or refreshes) the app token for the given region. Cached in
   * Redis with a 30-minute safety margin under the documented 24h lifetime.
   */
  private async getAppToken(region: string): Promise<string> {
    const cached = await redis.get(APP_TOKEN_REDIS_KEY(region));
    if (cached) return cached;

    if (!env.BLIZZARD_CLIENT_ID || !env.BLIZZARD_CLIENT_SECRET) {
      throw new Error(
        "BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET are not set; cannot fetch app token",
      );
    }

    const url = `${battleNetOAuthBase(region)}/token`;
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    const basic = Buffer.from(
      `${env.BLIZZARD_CLIENT_ID}:${env.BLIZZARD_CLIENT_SECRET}`,
    ).toString("base64");

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`blizzard app-token request failed: ${res.status} ${res.statusText}`);
    }
    const parsed = appTokenResponseSchema.parse(await res.json());

    // Cache for expires_in - 30min safety margin.
    const ttlSec = Math.max(60, parsed.expires_in - 30 * 60);
    await redis.set(APP_TOKEN_REDIS_KEY(region), parsed.access_token, "EX", ttlSec);
    return parsed.access_token;
  }
}

function wrap(err: unknown, msg: string, ctx: Record<string, unknown>): Error {
  const cause = err instanceof Error ? err : new Error(String(err));
  return new Error(`${msg}: ${cause.message} (${JSON.stringify(ctx)})`, { cause });
}

let _client: BlizzardClient | null = null;
export const blizzardClient = (): BlizzardClient => {
  if (!_client) _client = new BlizzardClient();
  return _client;
};
