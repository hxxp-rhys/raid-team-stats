/**
 * BullMQ worker process entrypoint. Runs as a separate Node process /
 * Docker service (see docker-compose `worker` service). Reads jobs from the
 * shared Redis queues and executes the per-tier handlers.
 *
 * Start with: `npx tsx src/server/ingestion/worker.ts`
 */

import { QueueEvents, Worker } from "bullmq";

import { redisBlocking } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { jobDurationSeconds, jobsTotal, queueDepth } from "@/lib/metrics";
import { QUEUE_NAMES } from "@/server/ingestion/queues";
import { queues } from "@/server/ingestion/queues";
import {
  handleManualRosterRefresh,
  type ManualRosterRefreshPayload,
} from "@/server/ingestion/jobs/manual-roster-refresh";
import {
  handleTrackedMemberSync,
  enqueueTrackedMemberSyncForAll,
  type TrackedMemberSyncPayload,
} from "@/server/ingestion/jobs/tracked-member-sync";
import {
  handleGuildRosterSync,
  enqueueGuildRosterSyncForAllGuilds,
  type GuildRosterSyncPayload,
} from "@/server/ingestion/jobs/guild-roster-sync";
import {
  handleGuildReportSync,
  enqueueGuildReportSyncForAll,
  type GuildReportSyncPayload,
} from "@/server/ingestion/jobs/guild-report-sync";
import { runTeamScheduleSweep } from "@/server/ingestion/jobs/team-schedule-sweeper";
import { runWorldDataRefresh } from "@/server/ingestion/jobs/wcl-worlddata-refresh";
import { runRetentionPrune } from "@/server/ingestion/jobs/admin-retention-prune";
import {
  runCalendarMaterializeSweep,
  runCalendarReminderSweep,
  runCalendarDiscordFanout,
  runCalendarDiscordAutoPost,
} from "@/server/ingestion/jobs/calendar-sweeper";
import { registerSchedules, FANOUT_KIND } from "@/server/ingestion/schedules";
import { runRecruitmentNotificationSweep } from "@/server/recruitment/notification-sweep";

const workers: Worker[] = [];

type FanoutPayload = { kind?: string };

const start = async () => {
  logger.info({}, "BullMQ worker process starting");

  workers.push(
    new Worker<ManualRosterRefreshPayload>(
      QUEUE_NAMES.manualRosterRefresh,
      async (job) => handleManualRosterRefresh(job.data, job),
      {
        connection: redisBlocking,
        concurrency: 2,
      },
    ).on("failed", (job, err) => {
      logger.error(
        { jobId: job?.id, attemptsMade: job?.attemptsMade, err },
        "manual-roster-refresh job failed",
      );
    }),
  );

  // Tier A — fan-out job + per-character jobs share the same queue.
  workers.push(
    new Worker<TrackedMemberSyncPayload | FanoutPayload>(
      QUEUE_NAMES.trackedMemberSync,
      async (job) => {
        if ((job.data as FanoutPayload).kind === FANOUT_KIND.tierA) {
          const r = await enqueueTrackedMemberSyncForAll();
          logger.info({ enqueued: r.enqueued }, "tier-a fanout queued");
          return;
        }
        await handleTrackedMemberSync(job.data as TrackedMemberSyncPayload);
      },
      {
        connection: redisBlocking,
        concurrency: 8,
      },
    ).on("failed", (job, err) => {
      logger.error(
        { jobId: job?.id, attemptsMade: job?.attemptsMade, err },
        "tier-a job failed",
      );
    }),
  );

  // Tier B — fan-out job + per-guild jobs share the same queue.
  workers.push(
    new Worker<GuildRosterSyncPayload | FanoutPayload>(
      QUEUE_NAMES.guildRosterSync,
      async (job) => {
        if ((job.data as FanoutPayload).kind === FANOUT_KIND.tierB) {
          const r = await enqueueGuildRosterSyncForAllGuilds();
          logger.info({ enqueued: r.enqueued }, "tier-b fanout queued");
          return;
        }
        await handleGuildRosterSync(job.data as GuildRosterSyncPayload);
      },
      {
        connection: redisBlocking,
        concurrency: 4,
      },
    ).on("failed", (job, err) => {
      logger.error(
        { jobId: job?.id, attemptsMade: job?.attemptsMade, err },
        "tier-b job failed",
      );
    }),
  );

  // GRS — fan-out job + per-guild WCL report ingestion share the queue.
  // Concurrency 2: each job makes a handful of WCL calls already smoothed
  // by the client's token bucket + points ledger.
  workers.push(
    new Worker<GuildReportSyncPayload | FanoutPayload>(
      QUEUE_NAMES.guildReportSync,
      async (job) => {
        if ((job.data as FanoutPayload).kind === FANOUT_KIND.grs) {
          const r = await enqueueGuildReportSyncForAll();
          logger.info({ enqueued: r.enqueued }, "grs fanout queued");
          return;
        }
        await handleGuildReportSync(job.data as GuildReportSyncPayload);
      },
      {
        connection: redisBlocking,
        concurrency: 2,
      },
    ).on("failed", (job, err) => {
      logger.error(
        { jobId: job?.id, attemptsMade: job?.attemptsMade, err },
        "guild-report-sync job failed",
      );
    }),
  );

  await registerSchedules();

  // WCL worldData refresh: persist the full zone/encounter snapshot + maintain
  // the live raid tier (WclZone.isCurrentRaid). Runs at startup (fresh after a
  // deploy / content patch) and every 6h. ~5 WCL pts/run; idempotent upsert.
  // Replaces the hand-maintained WCL_RAID_ZONE_ID env pin as the source of
  // truth (the pin, if set, still overrides + triggers a drift warning here).
  void runWorldDataRefresh().catch((err) =>
    logger.warn({ err }, "wcl worldData refresh failed (startup)"),
  );
  setInterval(() => {
    void runWorldDataRefresh().catch((err) =>
      logger.warn({ err }, "wcl worldData refresh failed"),
    );
  }, 6 * 60 * 60_000);

  // Data-retention prune: enforce the admin-configured retention policy
  // (AuditLog + SyncRun rows pruned directly; Loki access-log retention applied
  // via its delete API until the written config is picked up on restart). Runs
  // at startup + every 24h. No-op until an admin sets a finite retention.
  void runRetentionPrune().catch((err) =>
    logger.warn({ err }, "retention prune failed (startup)"),
  );
  setInterval(() => {
    void runRetentionPrune().catch((err) =>
      logger.warn({ err }, "retention prune failed"),
    );
  }, 24 * 60 * 60_000);

  // Periodic queue-depth gauge update — Prometheus pulls /api/metrics from
  // the web container, but the source of truth for queue counts is the
  // worker's view of Redis. Mirror the gauges via QueueEvents + a 15s tick.
  const queueObjects = [
    { name: "manual-roster-refresh", q: queues.manualRosterRefresh },
    { name: "tracked-member-sync", q: queues.trackedMemberSync },
    { name: "guild-roster-sync", q: queues.guildRosterSync },
    { name: "guild-report-sync", q: queues.guildReportSync },
  ];
  setInterval(async () => {
    for (const { name, q } of queueObjects) {
      try {
        const counts = await q.getJobCounts(
          "waiting",
          "active",
          "delayed",
          "failed",
        );
        for (const [state, n] of Object.entries(counts)) {
          queueDepth.set({ queue: name, state }, n);
        }
      } catch (err) {
        logger.warn({ err, queue: name }, "queue depth gauge refresh failed");
      }
    }
  }, 15_000);

  // Team-level recurring refresh sweeper. Runs every 5 minutes, checks each
  // team's per-team schedule, and enqueues a refresh when due. Bypasses the
  // user-trigger rate limit (the schedule is the limit).
  setInterval(() => {
    void runTeamScheduleSweep()
      .then((r) => {
        if (r.fired > 0) {
          logger.info(r, "team schedule sweep");
        }
      })
      .catch((err) => logger.warn({ err }, "team schedule sweep failed"));
  }, 5 * 60_000);

  // Calendar recurrence: roll active series forward into concrete events. Runs
  // at startup (fills any series created while the worker was down) and every
  // 30 minutes thereafter. Idempotent via the (seriesId, occurrenceDate) key.
  void runCalendarMaterializeSweep().catch((err) =>
    logger.warn({ err }, "calendar materialize sweep failed (startup)"),
  );
  setInterval(() => {
    void runCalendarMaterializeSweep().catch((err) =>
      logger.warn({ err }, "calendar materialize sweep failed"),
    );
  }, 30 * 60_000);

  // Calendar reminders: send the lead-time + no-response reminders that just
  // came due. Every 5 minutes — exactly-once via the SentReminder ledger.
  setInterval(() => {
    void runCalendarReminderSweep().catch((err) =>
      logger.warn({ err }, "calendar reminder sweep failed"),
    );
  }, 5 * 60_000);

  // Discord fan-out relay: drain the outbox into the team's signup-board embed
  // (post/edit-in-place). Every 3s — the relay poll floor; self-gates when
  // Discord is off, self-locks against overlap, coalesces per event.
  setInterval(() => {
    void runCalendarDiscordFanout().catch((err) =>
      logger.warn({ err }, "discord fanout sweep failed"),
    );
  }, 3_000);

  // Discord auto-post (opt-in): post boards for raids that have entered their
  // lead window. Every 5 minutes — far finer than the days-ahead lead needs.
  setInterval(() => {
    void runCalendarDiscordAutoPost().catch((err) =>
      logger.warn({ err }, "discord auto-post sweep failed"),
    );
  }, 5 * 60_000);

  // Recruitment notifications: drain the outbox to opted-in reviewers (email /
  // Discord DM). Every 15s — new applications reach reviewers promptly.
  setInterval(() => {
    void runRecruitmentNotificationSweep()
      .then((r) => {
        if (r.processed > 0) {
          logger.info(r, "recruitment notification sweep");
        }
      })
      .catch((err) =>
        logger.warn({ err }, "recruitment notification sweep failed"),
      );
  }, 15_000);

  // QueueEvents emits completed/failed across the cluster — count + measure.
  for (const { name, q } of queueObjects) {
    const events = new QueueEvents(q.name, { connection: redisBlocking });
    events.on("completed", async ({ jobId }) => {
      jobsTotal.inc({ queue: name, status: "completed" });
      const job = await q.getJob(jobId).catch(() => null);
      if (job?.processedOn && job?.finishedOn) {
        const sec = (job.finishedOn - job.processedOn) / 1000;
        jobDurationSeconds.observe({ queue: name }, sec);
      }
    });
    events.on("failed", () => jobsTotal.inc({ queue: name, status: "failed" }));
  }

  logger.info({ queues: workers.map((w) => w.name) }, "BullMQ workers online");
};

const shutdown = async () => {
  logger.info({}, "BullMQ worker shutting down");
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

void start();
