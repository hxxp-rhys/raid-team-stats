import { TRPCError } from "@trpc/server";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { consumeLimit, policies } from "@/server/security/rate-limit";
import { queues, QUEUE_NAMES } from "@/server/ingestion/queues";

/**
 * Team-level on-demand refresh. Enqueues a Tier-A sync for every active
 * member of a raid team using the existing `trackedMemberSync` queue.
 *
 * This is a NEW trigger surface — independent of the hourly cron — so it must
 * use a different jobId scheme than the cron's `tier-a:{cid}:{hourKey}` to
 * avoid being de-duped against the current hour's run.
 *
 * Rate-limited per-user and per-team. Platform admins (and ops scripts that
 * pass `bypassRateLimit`) skip both limits. Recurring scheduled refreshes also
 * bypass — the scheduler sets `bypassRateLimit: true` because the schedule
 * itself is the limit.
 */

export type EnqueueTeamRefreshInput = {
  raidTeamId: string;
  triggeredByUserId: string;
  source: "manual" | "scheduled";
};

export type EnqueueTeamRefreshOptions = {
  /**
   * Skip the per-user and per-team rate limits. Set by the tRPC layer when
   * the caller is an admin, and by the scheduler.
   */
  bypassRateLimit?: boolean;
};

export type EnqueueTeamRefreshResult =
  | { ok: true; enqueued: number; trigger: "manual" | "scheduled" }
  | { ok: false; reason: "rate_limited"; retryAfterMs: number }
  | { ok: false; reason: "no_members" };

export async function enqueueTeamRefresh(
  input: EnqueueTeamRefreshInput,
  options: EnqueueTeamRefreshOptions = {},
): Promise<EnqueueTeamRefreshResult> {
  if (!options.bypassRateLimit) {
    const userLimit = await consumeLimit(
      policies.teamRefreshPerUser,
      input.triggeredByUserId,
    );
    const teamLimit = await consumeLimit(
      policies.teamRefreshPerTeam,
      input.raidTeamId,
    );
    if (!userLimit.allowed || !teamLimit.allowed) {
      const retryAfterMs = Math.max(
        userLimit.allowed ? 0 : userLimit.resetAt - Date.now(),
        teamLimit.allowed ? 0 : teamLimit.resetAt - Date.now(),
      );
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Team refresh is rate-limited. Try again in a few minutes.",
        cause: { retryAfterMs },
      });
    }
  }

  const team = await db.raidTeam.findUnique({
    where: { id: input.raidTeamId },
    select: {
      memberships: {
        where: { isActive: true },
        select: { characterId: true },
      },
    },
  });
  if (!team) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  if (team.memberships.length === 0) {
    return { ok: false, reason: "no_members" };
  }

  // BullMQ rejects ":" in custom job ids — use "_" as the field separator.
  const triggerKey = `team-${input.source}_${input.raidTeamId}_${Date.now()}`;
  await queues.trackedMemberSync.addBulk(
    team.memberships.map((m) => ({
      name: QUEUE_NAMES.trackedMemberSync,
      data: { characterId: m.characterId },
      // jobId is per-character so bulk enqueue doesn't collide on itself, and
      // `triggerKey` keeps this batch distinct from the hourly cron's batch.
      opts: { jobId: `${triggerKey}_${m.characterId}` },
    })),
  );

  await db.raidTeam.update({
    where: { id: input.raidTeamId },
    data: { lastRefreshAt: new Date() },
  });

  logger.info(
    {
      raidTeamId: input.raidTeamId,
      enqueued: team.memberships.length,
      source: input.source,
      triggeredByUserId: input.triggeredByUserId,
    },
    "team refresh enqueued",
  );

  return {
    ok: true,
    enqueued: team.memberships.length,
    trigger: input.source,
  };
}
