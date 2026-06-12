import { logger } from "@/lib/logger";
import { queues } from "@/server/ingestion/queues";

/**
 * Idempotent registration of repeatable jobs. Called once at worker boot.
 * BullMQ dedupes by `jobId`, so multiple worker restarts won't create
 * duplicate cron entries.
 *
 * Schedule (America/New_York):
 *   - Tier A — every hour at :05
 *   - Tier B — Tuesday 06:00 ET (just after US weekly reset)
 *   - GRS    — every hour at :20 (offset from Tier A so the WCL points
 *              ledger isn't hit by both at once)
 *
 * Each repeatable job enqueues a "fan-out" job that, when processed,
 * gathers the work and adds per-character / per-guild jobs to the actual
 * processing queues.
 */

const TZ = "America/New_York";

export const SCHEDULER_QUEUE_NAME = "rts:scheduler";

/**
 * Register the cron entries. Safe to call multiple times.
 */
export async function registerSchedules(): Promise<void> {
  // BullMQ's repeatable-job semantics require the jobs to live in some queue.
  // We attach them to the existing tracked/guild queues so the worker process
  // sees them without an extra queue declaration.
  const tierAPattern = "5 * * * *"; // every hour at :05
  const tierBPattern = "0 6 * * 2"; // Tuesday 06:00
  const grsPattern = "20 * * * *"; // every hour at :20

  await queues.trackedMemberSync.add(
    "tier-a-fanout",
    { kind: "tier-a-fanout" },
    {
      jobId: "tier-a-fanout",
      repeat: { pattern: tierAPattern, tz: TZ },
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  );
  await queues.guildRosterSync.add(
    "tier-b-fanout",
    { kind: "tier-b-fanout" },
    {
      jobId: "tier-b-fanout",
      repeat: { pattern: tierBPattern, tz: TZ },
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  );
  await queues.guildReportSync.add(
    "grs-fanout",
    { kind: "grs-fanout" },
    {
      jobId: "grs-fanout",
      repeat: { pattern: grsPattern, tz: TZ },
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  );

  logger.info(
    { tierA: tierAPattern, tierB: tierBPattern, grs: grsPattern, tz: TZ },
    "schedules registered",
  );
}

export const FANOUT_KIND = {
  tierA: "tier-a-fanout",
  tierB: "tier-b-fanout",
  grs: "grs-fanout",
} as const;
