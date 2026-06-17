import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Enforce the admin-configured data-retention policy (the missing job the schema
 * has always referenced). Runs on the worker (boot + daily). Reads the
 * AdminSettings singleton; for each log type with a finite retention, deletes
 * rows older than the window.
 *
 *  - AuditLog / SyncRun: DB rows → deleted directly here.
 *  - Access/traffic logs (Loki): enforced via the Loki delete API, but ONLY
 *    while Loki's running retention differs from the target (once a Loki restart
 *    picks up the written config, the compactor enforces it and we stop calling
 *    the API).
 *
 * `null` retention = keep forever (skip). Never throws — logged + best-effort.
 */
export async function runRetentionPrune(): Promise<{
  auditLogDeleted: number;
  syncRunDeleted: number;
}> {
  const s = await db.adminSettings.findUnique({ where: { id: "singleton" } });
  if (!s) return { auditLogDeleted: 0, syncRunDeleted: 0 };

  const now = Date.now();
  const DAY = 86_400_000;
  let auditLogDeleted = 0;
  let syncRunDeleted = 0;

  if (s.auditLogRetentionDays != null) {
    const cutoff = new Date(now - s.auditLogRetentionDays * DAY);
    const r = await db.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    auditLogDeleted = r.count;
    if (r.count > 0) {
      logger.info(
        { deleted: r.count, days: s.auditLogRetentionDays },
        "retention: pruned AuditLog",
      );
    }
  }

  if (s.syncRunRetentionDays != null) {
    const cutoff = new Date(now - s.syncRunRetentionDays * DAY);
    const r = await db.syncRun.deleteMany({ where: { startedAt: { lt: cutoff } } });
    syncRunDeleted = r.count;
    if (r.count > 0) {
      logger.info(
        { deleted: r.count, days: s.syncRunRetentionDays },
        "retention: pruned SyncRun",
      );
    }
  }

  // Loki access/traffic logs — only while the running config hasn't caught up.
  if (s.accessLogRetentionDays != null) {
    try {
      const { lokiRunningRetentionHours, applyLokiRetention } = await import(
        "@/server/monitoring/loki-retention"
      );
      const running = await lokiRunningRetentionHours();
      const desiredHours = s.accessLogRetentionDays * 24;
      if (running == null || running !== desiredHours) {
        await applyLokiRetention(s.accessLogRetentionDays);
        logger.info(
          { days: s.accessLogRetentionDays, lokiRunningHours: running },
          "retention: enforced Loki access-log retention via delete API (config written for next restart)",
        );
      }
    } catch (err) {
      logger.warn({ err }, "retention: Loki access-log enforcement failed");
    }
  }

  return { auditLogDeleted, syncRunDeleted };
}
