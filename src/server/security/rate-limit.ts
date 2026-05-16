import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { redis } from "@/lib/redis";
import { env } from "@/env";

/**
 * Redis-backed sliding-window rate limiter (Lua-scripted for atomicity).
 *
 * - Stores hit timestamps in a sorted set keyed by `rl:{namespace}:{key}`.
 * - Each `consume()` removes timestamps older than (now - windowMs) and adds the
 *   current timestamp if the remaining count is under the limit.
 * - Returns { allowed, remaining, resetAt } so callers can emit standard
 *   `Retry-After` and `RateLimit-*` headers.
 *
 * Designed for short windows (seconds–minutes). For long windows (hours+), use
 * a separate token-bucket implementation; sorted-set memory grows with hit count.
 */

const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cutoff = now - windowMs

redis.call('ZREMRANGEBYSCORE', key, 0, cutoff)
local count = tonumber(redis.call('ZCARD', key))

if count < limit then
  redis.call('ZADD', key, now, tostring(now) .. ':' .. tostring(math.random()))
  redis.call('PEXPIRE', key, windowMs)
  local remaining = limit - count - 1
  return {1, remaining, now + windowMs}
end

local earliest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local resetAt = now + windowMs
if earliest[2] then
  resetAt = tonumber(earliest[2]) + windowMs
end
return {0, 0, resetAt}
`;

type Limit = {
  namespace: string;
  limit: number;
  windowMs: number;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
};

let scriptSha: string | null = null;
const loadScript = async (): Promise<string> => {
  if (scriptSha) return scriptSha;
  scriptSha = (await redis.script("LOAD", SLIDING_WINDOW_LUA)) as string;
  return scriptSha;
};

export const consumeLimit = async (
  { namespace, limit, windowMs }: Limit,
  key: string,
): Promise<RateLimitResult> => {
  const composite = `rl:${namespace}:${key}`;
  const now = Date.now();
  const sha = await loadScript();

  let result: [number, number, number];
  try {
    result = (await redis.evalsha(sha, 1, composite, now, windowMs, limit)) as [
      number,
      number,
      number,
    ];
  } catch (err) {
    if (err instanceof Error && err.message.includes("NOSCRIPT")) {
      scriptSha = null;
      result = (await redis.eval(SLIDING_WINDOW_LUA, 1, composite, now, windowMs, limit)) as [
        number,
        number,
        number,
      ];
    } else {
      throw err;
    }
  }

  return {
    allowed: result[0] === 1,
    limit,
    remaining: result[1],
    resetAt: result[2],
  };
};

const HEADER_CHAIN_KEYS = ["cf-connecting-ip", "true-client-ip", "x-real-ip"] as const;

const stableHash = (input: string): string =>
  createHash("sha256").update(input).digest("hex").slice(0, 16);

/**
 * Derives a stable rate-limit key from a request. By default uses the socket IP,
 * preferring well-known proxy headers only when RATE_LIMIT_TRUST_PROXY is true.
 * Returns a 16-char SHA-256 prefix (matches audit log ipHash format).
 */
export const ipKey = (request: NextRequest): string => {
  if (env.RATE_LIMIT_TRUST_PROXY) {
    for (const header of HEADER_CHAIN_KEYS) {
      const value = request.headers.get(header);
      if (value) return stableHash(value.split(",")[0]!.trim());
    }
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) return stableHash(forwarded.split(",")[0]!.trim());
  }
  // NextRequest does not expose remote address directly; the proxy must inject it.
  // Fall back to a UA-based bucket so we still throttle without trusting headers.
  return stableHash(request.headers.get("user-agent") ?? "anon");
};

/**
 * Default policies. Tune per surface. `windowMs` is in milliseconds.
 */
export const policies = {
  globalIp: { namespace: "global:ip", limit: 600, windowMs: 60_000 },
  authLoginPerIp: { namespace: "auth:login:ip", limit: 10, windowMs: 60_000 },
  authLoginPerEmail: { namespace: "auth:login:email", limit: 5, windowMs: 5 * 60_000 },
  authSignupPerIp: { namespace: "auth:signup:ip", limit: 5, windowMs: 60 * 60_000 },
  trpcMutationPerUser: { namespace: "trpc:mutation:user", limit: 120, windowMs: 60_000 },
  manualSyncPerUser: { namespace: "sync:manual:user", limit: 1, windowMs: 10 * 60_000 },
  manualSyncPerGuild: { namespace: "sync:manual:guild", limit: 1, windowMs: 5 * 60_000 },
  // Team-level data refresh (Tier-A re-trigger). Same shape as manualSync but
  // per-team and slightly more permissive — three per 10min for a leader who's
  // iterating on a dashboard, five per hour for the team as a whole.
  teamRefreshPerUser: { namespace: "team:refresh:user", limit: 3, windowMs: 10 * 60_000 },
  teamRefreshPerTeam: { namespace: "team:refresh:team", limit: 5, windowMs: 60 * 60_000 },
} as const satisfies Record<string, Limit>;
