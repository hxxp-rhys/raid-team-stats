/**
 * BullMQ worker process entrypoint. Runs as a separate Node process /
 * Docker service (see docker-compose `worker` service). Reads jobs from the
 * shared Redis queues and executes the per-tier handlers.
 *
 * Start with: `npx tsx src/server/ingestion/worker.ts`
 */

import { Worker } from "bullmq";

import { redisBlocking } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { QUEUE_NAMES } from "@/server/ingestion/queues";
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
import { registerSchedules, FANOUT_KIND } from "@/server/ingestion/schedules";

const workers: Worker[] = [];

type FanoutPayload = { kind?: string };

const start = async () => {
  logger.info({}, "BullMQ worker process starting");

  workers.push(
    new Worker<ManualRosterRefreshPayload>(
      QUEUE_NAMES.manualRosterRefresh,
      async (job) => handleManualRosterRefresh(job.data),
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

  await registerSchedules();

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
