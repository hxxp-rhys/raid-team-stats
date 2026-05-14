import { NextResponse } from "next/server";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";

type Check = { name: "db" | "redis"; ok: boolean; latencyMs: number; error?: string };

const checkDb = async (): Promise<Check> => {
  const start = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    return { name: "db", ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      name: "db",
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

const checkRedis = async (): Promise<Check> => {
  const start = Date.now();
  try {
    const reply = await redis.ping();
    return { name: "redis", ok: reply === "PONG", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      name: "redis",
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

/**
 * Readiness probe. Verifies the process can serve real traffic by hitting both
 * Postgres and Redis. 503 if any dependency is unreachable.
 */
export async function GET() {
  await connection(); // force dynamic rendering: probes must hit live deps each call
  const checks = await Promise.all([checkDb(), checkRedis()]);
  const ok = checks.every((c) => c.ok);
  if (!ok) logger.warn({ checks }, "readiness check failed");

  // Strip error messages from the public response; leak only to logs.
  const publicChecks = checks.map(({ name, ok, latencyMs }) => ({ name, ok, latencyMs }));

  return NextResponse.json(
    { status: ok ? "ready" : "not_ready", checks: publicChecks },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
