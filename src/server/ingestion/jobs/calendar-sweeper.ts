import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { materializeAllActiveSeries } from "@/server/calendar/materialize";
import { runReminderSweep } from "@/server/calendar/reminders";
import { runDiscordFanout } from "@/server/calendar/discord/fanout";

/**
 * Calendar background sweeps, driven from the worker's setInterval ticks:
 *  - materialize: roll recurring series forward into concrete RaidEvents.
 *  - reminders: send the auto-reminders that just came due.
 *
 * Correctness does NOT depend on the lock — the DB constraints are the
 * authority (the (seriesId, occurrenceDate) unique key for materialization and
 * the SentReminder (event, kind, user) unique key for reminders both guarantee
 * exactly-once even if two replicas run at once). The Redis soft-lock is purely
 * to avoid redundant work/log-noise; if Redis is unavailable we fail OPEN and
 * run anyway, leaning on those constraints.
 */

type LockState = "acquired" | "held" | "unavailable";

async function tryLock(key: string, ttlSec: number): Promise<LockState> {
  try {
    const res = await redis.set(key, "1", "EX", ttlSec, "NX");
    return res === null ? "held" : "acquired";
  } catch (err) {
    logger.warn({ err, key }, "calendar sweep: lock unavailable, running unlocked");
    return "unavailable";
  }
}

async function release(key: string, state: LockState): Promise<void> {
  if (state === "acquired") {
    await redis.del(key).catch(() => undefined);
  }
}

const MATERIALIZE_LOCK = "calendar:materialize:lock";
const REMINDER_LOCK = "calendar:reminders:lock";

/** Materialize all active series forward. Safe to call on a 30-min tick. */
export async function runCalendarMaterializeSweep(): Promise<{
  skipped?: boolean;
  series?: number;
  created?: number;
}> {
  const lock = await tryLock(MATERIALIZE_LOCK, 25 * 60);
  if (lock === "held") return { skipped: true };
  try {
    const res = await materializeAllActiveSeries(db);
    if (res.created > 0) logger.info(res, "calendar materialize sweep");
    return res;
  } finally {
    await release(MATERIALIZE_LOCK, lock);
  }
}

/**
 * Drain the Discord fan-out relay (outbox → embed post/edit). Safe to call on a
 * ~3s tick — self-gates when Discord is off and self-locks against overlap.
 */
export async function runCalendarDiscordFanout(): Promise<{
  skipped?: boolean;
  teams?: number;
  rendered?: number;
}> {
  return runDiscordFanout(db);
}

/** Send due auto-reminders. Safe to call on a 5-min tick. */
export async function runCalendarReminderSweep(): Promise<{
  skipped?: boolean;
  events?: number;
  sent?: number;
}> {
  const lock = await tryLock(REMINDER_LOCK, 4 * 60);
  if (lock === "held") return { skipped: true };
  try {
    const res = await runReminderSweep(db);
    if (res.sent > 0) logger.info(res, "calendar reminder sweep");
    return res;
  } finally {
    await release(REMINDER_LOCK, lock);
  }
}
