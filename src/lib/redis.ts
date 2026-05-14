import Redis, { type RedisOptions } from "ioredis";
import { env } from "@/env";
import { logger } from "@/lib/logger";

const buildClient = (extra: RedisOptions = {}) => {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
    ...extra,
  });

  client.on("error", (err) => {
    logger.error({ err }, "redis error");
  });

  return client;
};

const globalForRedis = globalThis as unknown as {
  __redis?: Redis;
  __redisBlocking?: Redis;
};

// Default shared client for app reads/writes (commands, rate limiting, cache).
export const redis = globalForRedis.__redis ?? buildClient();

// Separate connection for BullMQ workers (they require maxRetriesPerRequest:null + blocking ops).
export const redisBlocking =
  globalForRedis.__redisBlocking ?? buildClient({ enableOfflineQueue: false });

if (env.NODE_ENV !== "production") {
  globalForRedis.__redis = redis;
  globalForRedis.__redisBlocking = redisBlocking;
}
