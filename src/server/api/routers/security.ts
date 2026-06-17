import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { router, protectedProcedure, isPlatformAdmin } from "@/server/api/trpc";
import type { AuditEvent } from "@/generated/prisma/enums";

/**
 * Platform-admin-only security surface (the "Security" admin tab). Reads the
 * AuditLog signals that Phase 0 now emits (AUTHZ_DENIED, RATE_LIMIT_EXCEEDED)
 * plus the existing auth/privileged-action events, and flags concerning spikes
 * against the admin-configured thresholds. NOT_FOUND for non-admins (matches the
 * rest of the admin surface).
 */

async function assertAdmin(userId: string): Promise<void> {
  if (!(await isPlatformAdmin(userId))) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

const PRIVILEGED: AuditEvent[] = [
  "ADMIN_USER_PROMOTED",
  "ADMIN_USER_DEMOTED",
  "ADMIN_SETTINGS_UPDATED",
  "USER_DELETED",
  "RAID_TEAM_LEADERSHIP_TRANSFERRED",
  "RAID_TEAM_WCL_SOURCE_DATA_CLEARED",
  "GUILD_CLAIMED",
];

const SECURITY_FEED: AuditEvent[] = [
  "AUTH_LOGIN_FAILURE",
  "AUTHZ_DENIED",
  "RATE_LIMIT_EXCEEDED",
  "AUTH_MFA_DISABLED",
  "AUTH_PASSWORD_RESET_REQUEST",
  ...PRIVILEGED,
];

export const securityRouter = router({
  /** Concerning-signal counters + spike detection against admin thresholds. */
  overview: protectedProcedure.query(async ({ ctx }) => {
    await assertAdmin(ctx.session.user.id);

    const settings = await ctx.db.adminSettings.findUnique({
      where: { id: "singleton" },
    });
    const threshold = settings?.loginFailureAlertThreshold ?? 20;
    const windowMin = settings?.loginFailureWindowMinutes ?? 5;

    const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sinceWindow = new Date(Date.now() - windowMin * 60 * 1000);
    const count = (where: { event: AuditEvent | { in: AuditEvent[] }; gte: Date }) =>
      ctx.db.auditLog.count({
        where: { event: where.event, createdAt: { gte: where.gte } },
      });

    const [
      loginFailures24,
      loginFailuresWindow,
      authzDenied24,
      rateLimited24,
      mfaDisabled24,
      privileged24,
      pwResetReq24,
    ] = await Promise.all([
      count({ event: "AUTH_LOGIN_FAILURE", gte: since24 }),
      count({ event: "AUTH_LOGIN_FAILURE", gte: sinceWindow }),
      count({ event: "AUTHZ_DENIED", gte: since24 }),
      count({ event: "RATE_LIMIT_EXCEEDED", gte: since24 }),
      count({ event: "AUTH_MFA_DISABLED", gte: since24 }),
      count({ event: { in: PRIVILEGED }, gte: since24 }),
      count({ event: "AUTH_PASSWORD_RESET_REQUEST", gte: since24 }),
    ]);

    return {
      loginFailures24,
      authzDenied24,
      rateLimited24,
      mfaDisabled24,
      privileged24,
      pwResetReq24,
      loginFailureSpike: {
        count: loginFailuresWindow,
        threshold,
        windowMinutes: windowMin,
        alerting: loginFailuresWindow >= threshold,
      },
    };
  }),

  /** Recent security-relevant audit events (the live feed). */
  recentEvents: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      await assertAdmin(ctx.session.user.id);
      const rows = await ctx.db.auditLog.findMany({
        where: { event: { in: SECURITY_FEED } },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          event: true,
          actorUserId: true,
          subjectType: true,
          subjectId: true,
          ipHash: true,
          createdAt: true,
          metadata: true,
          actor: { select: { displayName: true } },
        },
      });
      return rows.map((r) => ({
        id: String(r.id),
        event: r.event,
        actor: r.actor?.displayName ?? r.actorUserId ?? "—",
        subjectType: r.subjectType,
        subjectId: r.subjectId,
        // 8-char prefix of the daily-salted hash — lets an admin see "same
        // source, same day" without exposing anything reversible.
        ipHashShort: r.ipHash ? r.ipHash.slice(0, 8) : null,
        createdAt: r.createdAt,
        metadata: r.metadata,
      }));
    }),
});
