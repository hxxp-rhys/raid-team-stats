import { TRPCError } from "@trpc/server";

import { logger } from "@/lib/logger";
import { queues, QUEUE_NAMES } from "@/server/ingestion/queues";
import { observeBattlenetGuilds } from "@/server/guild-auth/observe-battlenet";
import { applyVerification } from "@/server/guild-auth/verify";

/**
 * Battle.net character/guild discovery, run as a background job so it can fire
 * server-side on EVERY Battle.net login (not just when the client happens to
 * land on /account?bnet=linked). This is the same observe + applyVerification
 * pipeline as `guild.discoverFromBattlenet`, moved off the request path:
 *
 *   - reads the user's own Battle.net OAuth token,
 *   - lists their characters + each character's guild (+ roster rank),
 *   - upserts Character rows, matches EXISTING Guild rows (never auto-creates
 *     a guild — see createMissingGuilds), records presence (which, via
 *     recordGuildPresence, enqueues the per-character stat sync),
 *   - auto-joins the user to guilds already on the site as ACTIVE,
 *   - GM auto-claim + pending-asset transfer.
 *
 * Net effect for the user: after logging in with Battle.net their characters
 * appear and "Resync" works, with no manual "Reconnect" step.
 */
export type BattlenetDiscoverPayload = { userId: string };

export async function handleBattlenetDiscover(
  payload: BattlenetDiscoverPayload,
): Promise<void> {
  const { userId } = payload;

  let observations;
  try {
    const res = await observeBattlenetGuilds(userId);
    observations = res.observations;
  } catch (err) {
    // No linked Battle.net account, or the stored token is expired (Battle.net
    // issues no refresh token). Neither is retryable — the user must Reconnect
    // from /account, and the next login re-enqueues this. Other errors
    // (network / Blizzard 5xx) are transient → rethrow so BullMQ retries.
    if (err instanceof TRPCError && err.code === "PRECONDITION_FAILED") {
      logger.info(
        { userId },
        "battlenet-discover: token missing or expired; skipping (user must Reconnect)",
      );
      return;
    }
    throw err;
  }

  if (observations.length === 0) {
    logger.info({ userId }, "battlenet-discover: no characters observed");
    return;
  }

  const result = await applyVerification({
    userId,
    observedAt: new Date(),
    characters: observations,
    // OAuth proved ownership → re-attribute characters, auto-join guilds as
    // ACTIVE, run the GM auto-claim + pending-asset sweep. recordGuildPresence
    // enqueues the immediate per-character sync, so no extra enqueue here.
    verifiedOwnership: true,
    // Background login discovery is SITUATIONAL: auto-join only guilds already
    // on the site; never auto-create a guild just because the user is in it.
    // (The explicit "Add Guild" picker is the only create path.)
    createMissingGuilds: false,
  });

  logger.info({ userId, ...result }, "battlenet-discover complete");
}

/**
 * Enqueue a background discovery for a user. Fire-and-forget: a queue hiccup
 * must never block the login response or a button click.
 *
 * Dedupe: the jobId is bucketed to a ~10-minute window so rapid re-logins (or
 * a login racing the "Resync" button) collapse into one job, while a login in
 * a later window still re-discovers (picks up new characters / guild changes).
 */
export async function enqueueBattlenetDiscover(userId: string): Promise<void> {
  try {
    await queues.battlenetDiscover.add(
      QUEUE_NAMES.battlenetDiscover,
      { userId } satisfies BattlenetDiscoverPayload,
      { jobId: `bnet-discover_${userId}_${tenMinuteBucket()}` },
    );
  } catch (err) {
    logger.warn({ err, userId }, "battlenet-discover enqueue failed");
  }
}

function tenMinuteBucket(): string {
  const d = new Date();
  const mins = Math.floor(d.getUTCMinutes() / 10) * 10;
  return (
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}` +
    `${String(mins).padStart(2, "0")}`
  );
}
