import { randomBytes } from "node:crypto";

import { TRPCError } from "@trpc/server";

import { router, protectedProcedure } from "@/server/api/trpc";
import { consumeLimit, policies } from "@/server/security/rate-limit";
import { audit } from "@/server/security/audit";

/**
 * Account-level settings for the in-game addon + companion uploader:
 * the per-user upload token and recent upload status.
 */

const newToken = (): string =>
  randomBytes(32).toString("base64url"); // ~43 url-safe chars

export const accountRouter = router({
  /**
   * Current upload token (the user's own — safe to show them; they need it
   * to configure the companion) plus the most recent addon uploads.
   */
  uploadStatus: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
      select: { uploadToken: true },
    });
    const uploads = await ctx.db.addonUpload.findMany({
      where: { userId: ctx.session.user.id },
      orderBy: { receivedAt: "desc" },
      take: 20,
      select: {
        collectedAt: true,
        receivedAt: true,
        worldUnlocked: true,
        worldTotal: true,
        weeklyMplusRuns: true,
        addonVersion: true,
        character: { select: { name: true, realmSlug: true } },
      },
    });
    return { token: user?.uploadToken ?? null, uploads };
  }),

  /**
   * Generate (or rotate) the upload token. Rotating invalidates the old
   * one immediately — the companion must be reconfigured with the new value.
   */
  regenerateToken: protectedProcedure.mutation(async ({ ctx }) => {
    const token = newToken();
    await ctx.db.user.update({
      where: { id: ctx.session.user.id },
      data: { uploadToken: token },
    });
    return { token };
  }),

  /** Revoke the token (disables uploads until a new one is generated). */
  revokeToken: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.user.update({
      where: { id: ctx.session.user.id },
      data: { uploadToken: null },
    });
    return { ok: true };
  }),

  /**
   * Refresh THIS user's own data: enqueue a Tier-A re-sync (Blizzard + WCL
   * + Raider.IO) for every character the user owns, so their snapshots /
   * dashboard rows / upload status update. Rate-limited to once per 10
   * minutes per user (the shared manual-sync limiter).
   */
  refreshMyData: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.session.user.id;

    const rl = await consumeLimit(policies.manualSyncPerUser, userId);
    if (!rl.allowed) {
      const mins = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 60_000));
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `Data refresh is rate-limited. Try again in about ${mins} minute(s).`,
      });
    }

    const characters = await ctx.db.character.findMany({
      where: { userId },
      select: { id: true },
      take: 50, // sane cap; the per-provider token buckets gate spend anyway
    });
    if (characters.length === 0) {
      return { ok: false as const, reason: "no_characters" as const };
    }

    const { queues, QUEUE_NAMES } = await import(
      "@/server/ingestion/queues"
    );
    // Distinct jobId scheme so this batch isn't de-duped against the hourly
    // cron's `tier-a:{cid}:{hourKey}` jobs (BullMQ rejects ":" in ids).
    const triggerKey = `account-manual_${userId}_${Date.now()}`;
    await queues.trackedMemberSync.addBulk(
      characters.map((c) => ({
        name: QUEUE_NAMES.trackedMemberSync,
        data: { characterId: c.id },
        opts: { jobId: `${triggerKey}_${c.id}` },
      })),
    );

    await audit({
      event: "SYNC_TRIGGERED",
      actorUserId: userId,
      subjectType: "user",
      subjectId: userId,
      metadata: { tier: "account_manual", enqueued: characters.length },
    });

    return { ok: true as const, enqueued: characters.length };
  }),
});
