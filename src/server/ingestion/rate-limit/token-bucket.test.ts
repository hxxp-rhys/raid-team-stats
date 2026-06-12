import { afterAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { TokenBucket } from "./token-bucket";

// One client for the whole suite. lazyConnect defers the socket until the
// first command; the suite quits it exactly once in afterAll. (Per-test
// quit() + connect() on the SAME ioredis instance is a footgun: an instance
// reconnected after quit() comes back half-closed and the next command dies
// with "Connection is closed".)
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  lazyConnect: true,
});

const provider = (id: string) => `test-${id}-${Date.now()}`;

const flushBucket = async (p: string) => {
  await redis.del(`tb:${p}`);
};

describe.skipIf(process.env.SKIP_REDIS_TESTS === "1")("TokenBucket (live Redis)", () => {
  afterAll(async () => {
    await redis.quit().catch(() => {});
  });

  it("allows a burst up to capacity", async () => {
    const p = provider("burst");
    await flushBucket(p);
    const b = new TokenBucket({ provider: p, capacity: 5, refillPerSec: 1 });
    const results = await Promise.all(Array.from({ length: 5 }, () => b.take()));
    expect(results.every((r) => r.allowed)).toBe(true);
  });

  it("rejects when bucket is empty until refill", async () => {
    const p = provider("empty");
    await flushBucket(p);
    const b = new TokenBucket({ provider: p, capacity: 1, refillPerSec: 10 });
    const a = await b.take();
    const c = await b.take();
    expect(a.allowed).toBe(true);
    expect(c.allowed).toBe(false);
    expect(c.waitMs).toBeGreaterThan(0);
  });

  it("respects minFloor reservation", async () => {
    const p = provider("floor");
    await flushBucket(p);
    const b = new TokenBucket({ provider: p, capacity: 10, refillPerSec: 1 });
    // First call from a "bulk" caller demanding 5 tokens remain after take.
    const bulk = await b.take({ minFloor: 5 });
    expect(bulk.allowed).toBe(true);
    expect(bulk.remaining).toBe(9);

    // Drain to where remaining = 5, then bulk should be denied.
    for (let i = 0; i < 4; i++) {
      const r = await b.take({ minFloor: 5 });
      expect(r.allowed).toBe(true);
    }
    const denied = await b.take({ minFloor: 5 });
    expect(denied.allowed).toBe(false);

    // Interactive caller (no floor) can still take from the reserve.
    const interactive = await b.take({ minFloor: 0 });
    expect(interactive.allowed).toBe(true);
  });
});
