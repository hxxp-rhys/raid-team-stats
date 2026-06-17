import { promises as fs } from "node:fs";

import { env } from "@/env";
import { logger } from "@/lib/logger";

/**
 * Hybrid retention control for the Caddy access/traffic logs stored in Loki.
 *
 * The admin sets a target in the Settings tab. We then:
 *   1. ENFORCE IT IMMEDIATELY by submitting a Loki delete request for the access
 *      stream older than the target (Loki's compactor — already configured with
 *      `retention_enabled` + `delete_request_store` — processes it).
 *   2. PERSIST it by rewriting `retention_period` in ops/loki/loki-config.yml so
 *      that on the next Loki restart the compactor enforces it NATIVELY.
 *
 * The retention prune job then keeps using the delete API only WHILE Loki's
 * running retention (read from /config) differs from the target; once a restart
 * has picked up the written config, the API calls stop (the compactor owns it).
 *
 * Everything here is best-effort and isolated: failures are logged, never thrown
 * to the caller's critical path.
 */

const ACCESS_STREAM = '{container="rts-caddy"}';
// The repo source is bind-mounted into the web/worker containers at /app, so the
// Loki config file (also bind-mounted into the loki container) is writable here.
const LOKI_CONFIG_PATH = "/app/ops/loki/loki-config.yml";
// auth_enabled:false → Loki uses the default single tenant.
const ORG_HEADER: Record<string, string> = { "X-Scope-OrgID": "fake" };

const lokiBase = (): string => env.LOKI_URL.replace(/\/$/, "");

/** Submit a Loki delete request for access logs older than `days`. */
async function submitLokiDelete(days: number): Promise<void> {
  const endSec = Math.floor(Date.now() / 1000) - days * 86400;
  const url = `${lokiBase()}/loki/api/v1/delete?query=${encodeURIComponent(
    ACCESS_STREAM,
  )}&start=0&end=${endSec}`;
  const res = await fetch(url, { method: "POST", headers: ORG_HEADER });
  // 204 No Content on success; some versions return 200.
  if (!res.ok && res.status !== 204) {
    throw new Error(`loki delete returned ${res.status} ${res.statusText}`);
  }
}

/** Rewrite `retention_period` in the Loki config (takes effect on next restart). */
async function writeLokiConfigRetention(days: number): Promise<void> {
  const hours = days * 24;
  const text = await fs.readFile(LOKI_CONFIG_PATH, "utf8");
  const next = text.replace(
    /(^\s*retention_period:\s*)\d+h.*$/m,
    `$1${hours}h # ${days} days (admin-configured)`,
  );
  if (next === text) {
    logger.warn({}, "loki-retention: retention_period line not found in config");
    return;
  }
  await fs.writeFile(LOKI_CONFIG_PATH, next, "utf8");
}

/** The retention Loki is ACTUALLY running with (hours), read from /config, or null. */
export async function lokiRunningRetentionHours(): Promise<number | null> {
  try {
    const res = await fetch(`${lokiBase()}/config`, { headers: ORG_HEADER });
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/retention_period:\s*(\d+)h/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Apply the admin's access-log retention: immediate delete + durable config
 * write. `null` = keep forever (write a very long retention; don't delete).
 */
export async function applyLokiRetention(days: number | null): Promise<void> {
  if (days == null) {
    try {
      await writeLokiConfigRetention(3650);
    } catch (err) {
      logger.warn({ err }, "loki-retention: config write (keep-forever) failed");
    }
    return;
  }
  try {
    await submitLokiDelete(days);
  } catch (err) {
    logger.warn({ err, days }, "loki-retention: delete request failed");
  }
  try {
    await writeLokiConfigRetention(days);
  } catch (err) {
    logger.warn({ err, days }, "loki-retention: config write failed");
  }
}
