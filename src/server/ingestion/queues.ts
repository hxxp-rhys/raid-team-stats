import { Queue } from "bullmq";

import { redisBlocking } from "@/lib/redis";

/**
 * BullMQ queue declarations. Producers (tRPC mutations, schedulers) push
 * jobs into these queues; the separate worker process (src/server/ingestion/
 * worker.ts) registers handlers.
 *
 * All queues share the dedicated `redisBlocking` connection because BullMQ
 * requires the underlying ioredis instance to have `maxRetriesPerRequest:null`
 * and to be safe for blocking commands.
 */

// BullMQ rejects ":" in queue names (it's the Redis key separator). Use "-".
export const QUEUE_NAMES = {
  trackedMemberSync: "rts-tracked-member-sync",
  guildRosterSync: "rts-guild-roster-sync",
  manualRosterRefresh: "rts-manual-roster-refresh",
  guildReportSync: "rts-guild-report-sync",
  battlenetDiscover: "rts-battlenet-discover",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2_000 } as const,
  removeOnComplete: { age: 60 * 60 * 24, count: 1_000 },
  removeOnFail: { age: 60 * 60 * 24 * 7 },
};

export const queues = {
  trackedMemberSync: new Queue(QUEUE_NAMES.trackedMemberSync, {
    connection: redisBlocking,
    defaultJobOptions,
  }),
  guildRosterSync: new Queue(QUEUE_NAMES.guildRosterSync, {
    connection: redisBlocking,
    defaultJobOptions,
  }),
  manualRosterRefresh: new Queue(QUEUE_NAMES.manualRosterRefresh, {
    connection: redisBlocking,
    defaultJobOptions: {
      ...defaultJobOptions,
      attempts: 2, // user-triggered: fail fast and surface a friendly error.
    },
  }),
  guildReportSync: new Queue(QUEUE_NAMES.guildReportSync, {
    connection: redisBlocking,
    defaultJobOptions,
  }),
  battlenetDiscover: new Queue(QUEUE_NAMES.battlenetDiscover, {
    connection: redisBlocking,
    defaultJobOptions,
  }),
};
