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

const workers: Worker[] = [];

const start = () => {
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

  // Tier A (hourly tracked) and Tier B (weekly guild roster) workers
  // register here in subsequent phases.

  logger.info({ queues: workers.map((w) => w.name) }, "BullMQ workers online");
};

const shutdown = async () => {
  logger.info({}, "BullMQ worker shutting down");
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();
