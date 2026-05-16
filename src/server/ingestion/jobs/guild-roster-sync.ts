import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { queues, QUEUE_NAMES } from "@/server/ingestion/queues";
import { handleManualRosterRefresh } from "@/server/ingestion/jobs/manual-roster-refresh";

/**
 * Tier B — full-guild roster sync. Runs once a week (Tuesday 06:00
 * America/New_York) and refreshes the roster of every guild that has at
 * least one ACTIVE membership. Each per-guild job uses the same fetch
 * pipeline as the Tier C manual refresh — the only difference is the
 * `tier: "B"` SyncRun label and the absence of user-facing rate limits.
 */

export type GuildRosterSyncPayload = {
  guildId: string;
};

export async function enqueueGuildRosterSyncForAllGuilds(): Promise<{ enqueued: number }> {
  // A guild is "live" if any user has an ACTIVE membership.
  const guilds = await db.guild.findMany({
    where: {
      memberships: { some: { status: "ACTIVE" } },
    },
    select: { id: true },
  });
  if (guilds.length === 0) return { enqueued: 0 };

  await queues.guildRosterSync.addBulk(
    guilds.map((g) => ({
      name: QUEUE_NAMES.guildRosterSync,
      data: { guildId: g.id } satisfies GuildRosterSyncPayload,
      opts: { jobId: `weekly_${g.id}_${weekKey()}` },
    })),
  );
  return { enqueued: guilds.length };
}

export async function handleGuildRosterSync(payload: GuildRosterSyncPayload): Promise<void> {
  // For now, the per-guild work is identical to the Tier C refresh —
  // re-use the handler with a system-triggered userId placeholder.
  try {
    await handleManualRosterRefresh({
      guildId: payload.guildId,
      triggeredByUserId: "tier-b-scheduler",
    });
  } catch (err) {
    logger.error({ err, payload }, "tier-b guild-roster-sync failed");
    throw err;
  }
}

const weekKey = (): string => {
  const d = new Date();
  // ISO-ish week key — collapses to YYYY-Www so the same Tuesday produces the
  // same jobId and BullMQ refuses duplicate inserts (idempotent re-arming).
  const y = d.getUTCFullYear();
  const start = new Date(Date.UTC(y, 0, 1));
  const days = Math.floor((d.getTime() - start.getTime()) / 86_400_000);
  const week = Math.floor((days + start.getUTCDay()) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
};
