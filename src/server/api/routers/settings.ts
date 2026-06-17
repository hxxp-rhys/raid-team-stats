import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { router, protectedProcedure, isPlatformAdmin } from "@/server/api/trpc";
import { audit } from "@/server/security/audit";
import { logger } from "@/lib/logger";

/**
 * Admin-only customization + policy settings (the "Settings" admin tab). Backed
 * by the AdminSettings singleton. Every procedure re-checks admin (NOT_FOUND for
 * non-admins, matching the rest of the admin surface).
 */

const SETTINGS_ID = "singleton";

async function assertAdmin(userId: string): Promise<void> {
  if (!(await isPlatformAdmin(userId))) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

// Retention in days: 1 day … 10 years, or null = keep forever (no auto-prune).
const retentionDays = z.number().int().min(1).max(3650).nullable();

export const settingsRouter = router({
  /** Read the singleton, auto-creating it (with schema defaults) on first use. */
  get: protectedProcedure.query(async ({ ctx }) => {
    await assertAdmin(ctx.session.user.id);
    const existing = await ctx.db.adminSettings.findUnique({
      where: { id: SETTINGS_ID },
    });
    if (existing) return existing;
    return ctx.db.adminSettings.create({ data: { id: SETTINGS_ID } });
  }),

  update: protectedProcedure
    .input(
      z.object({
        auditLogRetentionDays: retentionDays.optional(),
        syncRunRetentionDays: retentionDays.optional(),
        accessLogRetentionDays: retentionDays.optional(),
        metricsRetentionDays: retentionDays.optional(),
        loginFailureAlertThreshold: z.number().int().min(1).max(100000).optional(),
        loginFailureWindowMinutes: z.number().int().min(1).max(1440).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertAdmin(ctx.session.user.id);

      const before = await ctx.db.adminSettings.findUnique({
        where: { id: SETTINGS_ID },
      });
      const updated = await ctx.db.adminSettings.upsert({
        where: { id: SETTINGS_ID },
        create: {
          id: SETTINGS_ID,
          ...input,
          updatedByUserId: ctx.session.user.id,
        },
        update: { ...input, updatedByUserId: ctx.session.user.id },
      });

      await audit({
        event: "ADMIN_SETTINGS_UPDATED",
        actorUserId: ctx.session.user.id,
        subjectType: "settings",
        subjectId: SETTINGS_ID,
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
        metadata: { changes: input },
      });

      // Access/traffic logs live in Loki: if the retention changed, enforce it
      // IMMEDIATELY via the Loki delete API AND persist it to the Loki config so
      // the compactor takes over on the next restart (best-effort; never blocks
      // saving the setting).
      if (
        input.accessLogRetentionDays !== undefined &&
        input.accessLogRetentionDays !== before?.accessLogRetentionDays
      ) {
        try {
          const { applyLokiRetention } = await import(
            "@/server/monitoring/loki-retention"
          );
          await applyLokiRetention(input.accessLogRetentionDays);
        } catch (err) {
          logger.warn({ err }, "settings: applyLokiRetention failed (continuing)");
        }
      }

      return updated;
    }),
});
