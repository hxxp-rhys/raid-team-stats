import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { enqueueTeamRefresh } from "@/server/ingestion/jobs/team-refresh";

/**
 * Periodic sweeper that fires team-level refreshes when their per-team
 * recurring schedule comes due. Runs every 5 minutes from the worker (see
 * worker.ts setInterval).
 *
 * Schedule shapes (RaidTeam.refreshSchedule JSON):
 *   - { kind: "interval", hours: N } — fire when (now - lastRefreshAt) >= N hours
 *   - { kind: "weekly", dayOfWeek, hour, minute } — fire when the most recent
 *     occurrence of that day/time is after lastRefreshAt
 *
 * The 5-minute tick is intentionally coarse — weekly schedules will fire
 * within 5 minutes of their scheduled time, which is fine for non-realtime
 * data ingestion. Trades schedule precision for fewer DB round-trips.
 */

type Schedule =
  | { kind: "interval"; hours: number }
  | { kind: "weekly"; dayOfWeek: number; hour: number; minute: number };

function parseSchedule(raw: unknown): Schedule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "interval" && typeof r.hours === "number") {
    return { kind: "interval", hours: r.hours };
  }
  if (
    r.kind === "weekly" &&
    typeof r.dayOfWeek === "number" &&
    typeof r.hour === "number" &&
    typeof r.minute === "number"
  ) {
    return {
      kind: "weekly",
      dayOfWeek: r.dayOfWeek,
      hour: r.hour,
      minute: r.minute,
    };
  }
  return null;
}

/**
 * Returns the most recent scheduled "fire time" at or before `now`.
 * Used to compare against lastRefreshAt: if the most recent scheduled time
 * is newer than lastRefreshAt, we owe a fire.
 */
function mostRecentScheduledTime(schedule: Schedule, now: Date): Date {
  if (schedule.kind === "interval") {
    // Interval doesn't have a "wall-clock" anchor — the most recent fire is
    // simply (now). The caller decides based on lastRefreshAt + hours.
    return now;
  }
  // Weekly: walk backwards from `now` to find the most recent matching
  // (dayOfWeek, hour, minute). Local-time interpretation matches what the
  // user typed in the widget.
  const d = new Date(now);
  d.setSeconds(0, 0);
  for (let i = 0; i < 8; i++) {
    if (
      d.getDay() === schedule.dayOfWeek &&
      d.getHours() === schedule.hour &&
      d.getMinutes() >= schedule.minute
    ) {
      d.setMinutes(schedule.minute);
      return d;
    }
    d.setDate(d.getDate() - 1);
    d.setHours(schedule.hour, schedule.minute, 0, 0);
  }
  // Fallback — should be unreachable.
  return now;
}

export async function runTeamScheduleSweep(): Promise<{
  checked: number;
  fired: number;
}> {
  const teams = await db.raidTeam.findMany({
    where: { refreshSchedule: { not: undefined } },
    select: {
      id: true,
      leaderUserId: true,
      refreshSchedule: true,
      lastRefreshAt: true,
    },
  });
  const now = new Date();
  let fired = 0;
  for (const t of teams) {
    const schedule = parseSchedule(t.refreshSchedule);
    if (!schedule) continue;

    const last = t.lastRefreshAt;
    let due = false;
    if (schedule.kind === "interval") {
      if (!last) {
        due = true;
      } else {
        const elapsedHours = (now.getTime() - last.getTime()) / 3_600_000;
        due = elapsedHours >= schedule.hours;
      }
    } else {
      const scheduledFire = mostRecentScheduledTime(schedule, now);
      // Don't fire jobs from older than the current week's slot — if
      // lastRefreshAt is null, only fire if the most recent scheduled time
      // is within the last hour (avoids back-fill storms after a long worker
      // downtime).
      if (!last) {
        due = now.getTime() - scheduledFire.getTime() < 60 * 60_000;
      } else {
        due = scheduledFire.getTime() > last.getTime();
      }
    }

    if (!due) continue;

    // The scheduler needs some user attribution. Falls back to a synthetic
    // "scheduler" sentinel when the team has no on-site leader (the leader
    // departed and no successor has been assigned yet). Rate-limit bypass is
    // on regardless, so the sentinel is purely for audit attribution.
    const triggeredByUserId = t.leaderUserId ?? "team-scheduler";

    try {
      const res = await enqueueTeamRefresh(
        {
          raidTeamId: t.id,
          triggeredByUserId,
          source: "scheduled",
        },
        { bypassRateLimit: true },
      );
      if (res.ok) fired++;
    } catch (err) {
      logger.warn(
        { err, raidTeamId: t.id },
        "team schedule sweep: enqueue failed",
      );
    }
  }
  return { checked: teams.length, fired };
}
