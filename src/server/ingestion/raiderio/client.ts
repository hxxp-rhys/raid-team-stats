import { z, type ZodTypeAny } from "zod";

import { env } from "@/env";
import { logger } from "@/lib/logger";
import { raiderioBucket } from "@/server/ingestion/rate-limit/token-bucket";

/**
 * Raider.IO REST client. Public endpoints don't require auth; if
 * RAIDERIO_API_KEY is set it's passed through as a Bearer token (some
 * endpoints accept it for higher quotas).
 */

const BASE_URL = "https://raider.io/api/v1";

type GetOptions<S extends ZodTypeAny> = {
  path: string;
  query?: Record<string, string | number | undefined>;
  schema: S;
};

export class RaiderIOClient {
  async get<S extends ZodTypeAny>(opts: GetOptions<S>): Promise<z.infer<S>> {
    await raiderioBucket.takeOrWait();

    const url = new URL(opts.path.replace(/^\//, "") + "", BASE_URL + "/");
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "raid-team-stats/0.1",
    };
    if (env.RAIDERIO_API_KEY) {
      headers.Authorization = `Bearer ${env.RAIDERIO_API_KEY}`;
    }

    const res = await fetch(url.toString(), { headers });
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after") ?? "5");
      logger.warn({ retry }, "raiderio 429");
      await new Promise((r) => setTimeout(r, retry * 1000));
      const retried = await fetch(url.toString(), { headers });
      if (!retried.ok) throw new Error(`raiderio retry failed: ${retried.status}`);
      return parseOrThrow(await retried.json(), opts.schema);
    }
    if (!res.ok) {
      throw new Error(`raiderio ${res.status} ${res.statusText} ${url.pathname}`);
    }
    return parseOrThrow(await res.json(), opts.schema);
  }
}

function parseOrThrow<S extends ZodTypeAny>(json: unknown, schema: S): z.infer<S> {
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues.slice(0, 5) }, "raiderio schema mismatch");
    throw new Error("raiderio response did not match schema");
  }
  return parsed.data;
}

/**
 * Build the canonical character-profile fields string. Caller picks which
 * fields the dashboard needs — Raider.IO charges roughly proportional to
 * response size so it's worth being explicit.
 */
export const characterProfileFields = (...fields: string[]): string => fields.join(",");

let _client: RaiderIOClient | null = null;
export const raiderIOClient = (): RaiderIOClient => {
  if (!_client) _client = new RaiderIOClient();
  return _client;
};
