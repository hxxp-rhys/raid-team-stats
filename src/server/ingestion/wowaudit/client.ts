import type { ZodTypeAny, z } from "zod";

import { logger } from "@/lib/logger";
import { wowauditBucket } from "@/server/ingestion/rate-limit/token-bucket";
import {
  DEFAULT_WOWAUDIT_BASE_URL,
  loadDecryptedConfig,
  type WowauditDecryptedConfig,
} from "@/server/ingestion/wowaudit/config";
import {
  wowauditTeamSchema,
  wowauditRosterResponseSchema,
} from "@/server/ingestion/wowaudit/schemas";

/**
 * Per-guild WoW Audit client. Each call resolves the guild's stored config,
 * decrypts the API key in memory, and issues a single HTTPS request through
 * the shared token bucket.
 *
 * Status: SCAFFOLDING. The endpoint paths below are educated placeholders
 * (WoW Audit publishes their reference per-team behind login). When the real
 * docs are confirmed, update `paths` and the matching schemas in
 * `wowaudit/schemas.ts`. The ingestion pipeline and UI consume this module
 * through a typed surface, so swapping in real paths is a one-file change.
 *
 * Authentication is assumed to be a static Bearer / API-Key header. The
 * exact header name (e.g. `Authorization: ApiKey <key>` vs
 * `X-Api-Key: <key>`) is parameterised — adjust `authHeader()` once known.
 */

// WoW Audit v1 endpoints. Confirmed against the public WoW Audit data
// model + community clients: base is https://wowaudit.com/v1 and the auth
// header is `Authorization: <raw key>` (no Bearer prefix). `/characters`
// is the roster endpoint the official audit spreadsheet consumes.
const paths = {
  team: "characters", // no dedicated /team; /characters doubles as a probe
  roster: "characters",
} as const;

const DEFAULT_TIMEOUT_MS = 15_000;

const authHeader = (key: string): HeadersInit => ({
  // WoW Audit v1 uses the raw key as the Authorization header value (no
  // "Bearer " prefix) — confirmed against the official audit spreadsheet
  // and community clients (e.g. brikr/wowaudit-tools).
  Authorization: key,
  Accept: "application/json",
  "User-Agent": "raid-team-stats/0.1 (+https://github.com/hxxp-rhys/raid-stats)",
});

type RequestOptions<S extends ZodTypeAny> = {
  schema: S;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
};

export class WowauditClient {
  private constructor(private readonly config: WowauditDecryptedConfig) {}

  /**
   * Resolves the per-guild config from the database and returns a ready
   * client. Returns null if the guild has no WoW Audit key configured —
   * callers should skip the source rather than throwing.
   */
  static async forGuild(guildId: string): Promise<WowauditClient | null> {
    const config = await loadDecryptedConfig(guildId);
    if (!config) return null;
    return new WowauditClient(config);
  }

  /**
   * Same shape as `WowauditClient` but built from an explicit config — used
   * by the "test connection" endpoint where the officer pastes a candidate
   * key and we verify it before persisting.
   */
  static fromConfig(config: WowauditDecryptedConfig): WowauditClient {
    return new WowauditClient(config);
  }

  private async request<S extends ZodTypeAny>(
    path: string,
    options: RequestOptions<S>,
  ): Promise<z.infer<S>> {
    await wowauditBucket.takeOrWait();

    const baseUrl = this.config.baseUrl?.trim() || DEFAULT_WOWAUDIT_BASE_URL;
    // Strip any leading slash on `path` so it appends to the versioned base
    // (`/v1`) instead of replacing the whole path (a leading-slash relative
    // URL resets to the host root and would drop `/v1`).
    const url = new URL(
      path.replace(/^\/+/, ""),
      baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
    );
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: authHeader(this.config.apiKey),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // 401 / 403 most commonly mean the API key is invalid or revoked.
      if (res.status === 401 || res.status === 403) {
        throw new Error("wowaudit: authentication failed (check API key)");
      }
      if (res.status === 429) {
        throw new Error("wowaudit: rate limited (HTTP 429)");
      }
      throw new Error(`wowaudit: HTTP ${res.status} ${res.statusText} for ${path}`);
    }

    const json = await res.json();
    const parsed = options.schema.safeParse(json);
    if (!parsed.success) {
      logger.error(
        { path, issues: parsed.error.issues.slice(0, 5) },
        "wowaudit response schema mismatch",
      );
      throw new Error(`wowaudit: response did not match schema for ${path}`);
    }
    return parsed.data;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Public API surface (WoW Audit v1).
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Team roster with the full audit column set (incl. the nine Great Vault
   * slot columns). Always returns a flat array regardless of whether the
   * API wraps it in `{ characters: [...] }`.
   */
  async getCharacters() {
    const res = await this.request(paths.roster, {
      schema: wowauditRosterResponseSchema,
    });
    return Array.isArray(res) ? res : res.characters;
  }

  /** Back-compat alias. */
  async getRoster() {
    return this.getCharacters();
  }

  /** Team metadata probe (kept permissive). */
  async getTeam() {
    return this.request(paths.team, { schema: wowauditTeamSchema });
  }

  /**
   * Liveness probe for the settings "test connection" button — hits the
   * real `/characters` endpoint so a bad key / no-API-access plan fails
   * loudly here instead of silently during ingestion.
   */
  async ping(): Promise<
    { ok: true; characters: number } | { ok: false; error: string }
  > {
    try {
      const chars = await this.getCharacters();
      return { ok: true, characters: chars.length };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, error };
    }
  }
}
