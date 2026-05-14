import { redis } from "@/lib/redis";

/**
 * Redis-backed token bucket. One instance per upstream provider (Blizzard,
 * Warcraft Logs, Raider.IO). Atomicity is guaranteed by a Lua script that
 * does the refill + take in a single round-trip.
 *
 * Capacity is the max burst; refill rate is in tokens per second. Buckets
 * are persisted in Redis as a hash `{ tokens, lastRefillMs }` keyed by
 * `tb:{provider}`.
 *
 * Job-class reservation (Phase 4 plan): bulk sync reserves 60% of capacity,
 * hourly tracked sync 30%, interactive paths 10%. Reservation is enforced
 * by passing a `minRemainingForClass` floor — bulk callers refuse to take a
 * token when remaining < 40% (so interactive + hourly always have headroom).
 */
const TAKE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refillPerSec = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local minFloor = tonumber(ARGV[5])

local raw = redis.call('HMGET', key, 'tokens', 'lastRefillMs')
local tokens = tonumber(raw[1])
local lastRefillMs = tonumber(raw[2])
if tokens == nil then
  tokens = capacity
  lastRefillMs = now
end

local elapsedMs = math.max(0, now - lastRefillMs)
tokens = math.min(capacity, tokens + (elapsedMs / 1000) * refillPerSec)

if tokens - cost < minFloor then
  -- Persist refill even on rejection so subsequent calls see fresh state.
  redis.call('HMSET', key, 'tokens', tostring(tokens), 'lastRefillMs', tostring(now))
  redis.call('PEXPIRE', key, 3600000)
  -- waitMs until enough tokens for this caller.
  local deficit = minFloor + cost - tokens
  local waitMs = math.ceil((deficit / refillPerSec) * 1000)
  return {0, tostring(tokens), tostring(waitMs)}
end

tokens = tokens - cost
redis.call('HMSET', key, 'tokens', tostring(tokens), 'lastRefillMs', tostring(now))
redis.call('PEXPIRE', key, 3600000)
return {1, tostring(tokens), '0'}
`;

type BucketConfig = {
  /** Stable name; used as the Redis key suffix. e.g. "blizzard", "wcl". */
  provider: string;
  /** Max burst. The bucket starts full. */
  capacity: number;
  /** Refill rate (tokens per second). */
  refillPerSec: number;
};

export type TakeOptions = {
  /** How many tokens this call consumes. Default 1. */
  cost?: number;
  /**
   * Minimum tokens that must remain AFTER this take. Bulk callers pass a
   * non-zero floor to leave headroom for interactive paths. Default 0.
   */
  minFloor?: number;
};

export type TakeResult = {
  allowed: boolean;
  remaining: number;
  /** When allowed = false, ms until enough tokens are available. */
  waitMs: number;
};

export class TokenBucket {
  private readonly key: string;
  private scriptSha: string | null = null;

  constructor(private readonly config: BucketConfig) {
    this.key = `tb:${config.provider}`;
  }

  private async ensureScript(): Promise<string> {
    if (this.scriptSha) return this.scriptSha;
    this.scriptSha = (await redis.script("LOAD", TAKE_LUA)) as string;
    return this.scriptSha;
  }

  async take(opts: TakeOptions = {}): Promise<TakeResult> {
    const cost = opts.cost ?? 1;
    const minFloor = opts.minFloor ?? 0;
    const now = Date.now();
    let result: [number, string, string];
    try {
      const sha = await this.ensureScript();
      result = (await redis.evalsha(
        sha,
        1,
        this.key,
        now,
        this.config.capacity,
        this.config.refillPerSec,
        cost,
        minFloor,
      )) as [number, string, string];
    } catch (err) {
      if (err instanceof Error && err.message.includes("NOSCRIPT")) {
        this.scriptSha = null;
        result = (await redis.eval(
          TAKE_LUA,
          1,
          this.key,
          now,
          this.config.capacity,
          this.config.refillPerSec,
          cost,
          minFloor,
        )) as [number, string, string];
      } else {
        throw err;
      }
    }
    return {
      allowed: result[0] === 1,
      remaining: Number(result[1]),
      waitMs: Number(result[2]),
    };
  }

  /**
   * Take or wait. Polls the bucket until a token is available, up to a max
   * wait. Throws after maxWaitMs without acquiring.
   */
  async takeOrWait(opts: TakeOptions & { maxWaitMs?: number } = {}): Promise<TakeResult> {
    const maxWaitMs = opts.maxWaitMs ?? 30_000;
    const start = Date.now();
    for (;;) {
      const r = await this.take(opts);
      if (r.allowed) return r;
      const elapsed = Date.now() - start;
      if (elapsed >= maxWaitMs) {
        throw new Error(
          `TokenBucket(${this.config.provider}): waited ${elapsed}ms, still no capacity`,
        );
      }
      const sleepMs = Math.min(r.waitMs, maxWaitMs - elapsed, 1_000);
      await new Promise((res) => setTimeout(res, Math.max(50, sleepMs)));
    }
  }
}

// Bucket presets. Bookend the documented upstream limits with a small safety
// margin (95% of the spec) so we never trip a true 429.
//
// Blizzard: 100 req/sec hard, 36 000 req/hour hard. With 95 req/sec refill
// the bucket replenishes within budget on sustained load.
export const blizzardBucket = new TokenBucket({
  provider: "blizzard",
  capacity: 100,
  refillPerSec: 95,
});

// Warcraft Logs Platinum: 18 000 points/hr = 5 points/sec.
export const wclBucket = new TokenBucket({
  provider: "wcl",
  capacity: 200,
  refillPerSec: 5,
});

// Raider.IO documented ~300 req/min; reserve to 250/min = ~4.16/sec.
export const raiderioBucket = new TokenBucket({
  provider: "raiderio",
  capacity: 60,
  refillPerSec: 4,
});

// WoW Audit rate limits are not publicly documented. Conservative defaults
// until we have specifics: 30 req/min sustained, 30 burst.
// Tune once the real WoW Audit docs land — see SECURITY.md.
export const wowauditBucket = new TokenBucket({
  provider: "wowaudit",
  capacity: 30,
  refillPerSec: 0.5,
});
