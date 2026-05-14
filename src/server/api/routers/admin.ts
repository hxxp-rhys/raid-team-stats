import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { router, protectedProcedure } from "@/server/api/trpc";
import { env } from "@/env";

/**
 * Platform-admin-only inspection of the BullMQ queues and recent SyncRun
 * rows. Gated on `env.ADMIN_USER_IDS` — even guild OWNERs see NOT_FOUND.
 *
 * The BullMQ `queues` module is lazy-imported inside each procedure: at
 * top-level it would instantiate Queue objects at module load, which
 * crashes the Next 16 page-data collection step during prod builds.
 *
 * Read-only for v1: no retry / pause / drain mutations. Add those when the
 * operations workflow demands them; keep the principle-of-least-privilege
 * surface minimal until then.
 */

const QUEUE_NAMES_ENUM = z.enum([
  "manual-roster-refresh",
  "tracked-member-sync",
  "guild-roster-sync",
]);

const assertAdmin = (userId: string) => {
  if (!env.ADMIN_USER_IDS.includes(userId)) {
    // NOT_FOUND, not FORBIDDEN — don't reveal that the admin surface exists.
    throw new TRPCError({ code: "NOT_FOUND" });
  }
};

export const adminRouter = router({
  /**
   * Snapshot of queue state — count by status, plus the most recent N jobs
   * from each terminal status (completed + failed) for visual triage.
   */
  queueStatus: protectedProcedure
    .input(
      z.object({
        queueName: QUEUE_NAMES_ENUM.optional(),
        recentLimit: z.number().int().min(1).max(50).default(10),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertAdmin(ctx.session.user.id);
      const { queues } = await import("@/server/ingestion/queues");
      const queueMap = {
        "manual-roster-refresh": queues.manualRosterRefresh,
        "tracked-member-sync": queues.trackedMemberSync,
        "guild-roster-sync": queues.guildRosterSync,
      } as const;

      const queueKeys: Array<keyof typeof queueMap> = input.queueName
        ? [input.queueName]
        : (Object.keys(queueMap) as Array<keyof typeof queueMap>);

      const result = await Promise.all(
        queueKeys.map(async (name) => {
          const queue = queueMap[name];
          const counts = await queue.getJobCounts(
            "waiting",
            "active",
            "completed",
            "failed",
            "delayed",
          );
          const [completed, failed] = await Promise.all([
            queue.getJobs(["completed"], 0, input.recentLimit - 1, true),
            queue.getJobs(["failed"], 0, input.recentLimit - 1, true),
          ]);
          const project = (
            list: Awaited<ReturnType<typeof queue.getJobs>>,
            status: "completed" | "failed",
          ) =>
            list.map((j) => ({
              id: j.id ?? "",
              name: j.name,
              status,
              attemptsMade: j.attemptsMade,
              timestamp: j.timestamp,
              finishedOn: j.finishedOn ?? null,
              processedOn: j.processedOn ?? null,
              failedReason: j.failedReason ?? null,
            }));
          return {
            name,
            counts,
            recent: [...project(completed, "completed"), ...project(failed, "failed")]
              .sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0))
              .slice(0, input.recentLimit),
          };
        }),
      );

      return { queues: result };
    }),

  /**
   * The last N SyncRun rows for triage. Cross-references with queue jobs above.
   */
  recentSyncRuns: protectedProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).default(25),
        guildId: z.string().cuid().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertAdmin(ctx.session.user.id);
      return ctx.db.syncRun.findMany({
        where: input.guildId ? { guildId: input.guildId } : undefined,
        orderBy: { startedAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          tier: true,
          source: true,
          guildId: true,
          characterId: true,
          startedAt: true,
          finishedAt: true,
          ok: true,
          errorMessage: true,
          metrics: true,
        },
      });
    }),
});
