import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  router,
  protectedProcedure,
  isPlatformAdmin,
} from "@/server/api/trpc";
import { audit } from "@/server/security/audit";

/**
 * Platform-admin-only inspection + management surface.
 *
 * Gating: every procedure runs `assertAdmin(ctx.session.user.id)` which
 * resolves via the three platform-admin sources (env id, env email, or
 * User.isAdmin). Non-admins get NOT_FOUND so we don't reveal the surface
 * exists.
 *
 * The BullMQ `queues` module is lazy-imported inside each procedure: at
 * top-level it would instantiate Queue objects at module load, which crashes
 * the Next 16 page-data collection step during prod builds.
 */

const QUEUE_NAMES_ENUM = z.enum([
  "manual-roster-refresh",
  "tracked-member-sync",
  "guild-roster-sync",
]);

async function assertAdmin(userId: string): Promise<void> {
  if (!(await isPlatformAdmin(userId))) {
    // NOT_FOUND, not FORBIDDEN — don't reveal that the admin surface exists.
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

export const adminRouter = router({
  // ────────────────────────────────────────────────────────────────────────
  // BullMQ queue inspection (read-only)
  // ────────────────────────────────────────────────────────────────────────

  queueStatus: protectedProcedure
    .input(
      z.object({
        queueName: QUEUE_NAMES_ENUM.optional(),
        recentLimit: z.number().int().min(1).max(50).default(10),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertAdmin(ctx.session.user.id);
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
      await assertAdmin(ctx.session.user.id);
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

  // ────────────────────────────────────────────────────────────────────────
  // User management
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Distinct filter values to populate the dropdowns on the admin user list.
   * Cheap enough to recompute on every page open — at our scale.
   */
  filterOptions: protectedProcedure.query(async ({ ctx }) => {
    await assertAdmin(ctx.session.user.id);
    const [regions, realms, guilds] = await Promise.all([
      ctx.db.character.groupBy({
        by: ["region"],
        _count: { region: true },
        orderBy: { region: "asc" },
      }),
      ctx.db.character.groupBy({
        by: ["region", "realmSlug"],
        _count: { realmSlug: true },
        orderBy: [{ region: "asc" }, { realmSlug: "asc" }],
      }),
      ctx.db.guild.findMany({
        select: {
          id: true,
          name: true,
          region: true,
          realmSlug: true,
          faction: true,
        },
        orderBy: [{ region: "asc" }, { name: "asc" }],
      }),
    ]);
    return {
      regions: regions.map((r) => ({ value: r.region, count: r._count.region })),
      realms: realms.map((r) => ({
        region: r.region,
        realmSlug: r.realmSlug,
        count: r._count.realmSlug,
      })),
      guilds,
    };
  }),

  /**
   * List users with search + filters + pagination.
   *
   * Filters:
   *  - search: matches against email or displayName (case-insensitive prefix)
   *  - region: matches if user has any Character in this region
   *  - realmSlug: matches if user has any Character on this realm
   *  - guildId: matches if user has any GuildMembership in this guild
   */
  listUsers: protectedProcedure
    .input(
      z.object({
        search: z.string().trim().max(120).optional(),
        region: z.enum(["US", "EU", "KR", "TW"]).optional(),
        realmSlug: z.string().trim().max(80).optional(),
        guildId: z.string().cuid().optional(),
        adminOnly: z.boolean().optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertAdmin(ctx.session.user.id);

      const where: import("@/generated/prisma/client").Prisma.UserWhereInput = {};
      if (input.search) {
        where.OR = [
          { email: { contains: input.search, mode: "insensitive" } },
          { displayName: { contains: input.search, mode: "insensitive" } },
        ];
      }
      if (input.adminOnly) {
        where.isAdmin = true;
      }

      const charFilter: import("@/generated/prisma/client").Prisma.CharacterWhereInput = {};
      if (input.region) charFilter.region = input.region;
      if (input.realmSlug) charFilter.realmSlug = input.realmSlug;
      if (input.region || input.realmSlug) {
        where.characters = { some: charFilter };
      }
      if (input.guildId) {
        where.guildMemberships = { some: { guildId: input.guildId } };
      }

      const [total, rows] = await Promise.all([
        ctx.db.user.count({ where }),
        ctx.db.user.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
          select: {
            id: true,
            email: true,
            displayName: true,
            isAdmin: true,
            emailVerified: true,
            mfaEnabled: true,
            createdAt: true,
            _count: {
              select: {
                characters: true,
                guildMemberships: { where: { status: "ACTIVE" } },
              },
            },
          },
        }),
      ]);

      return {
        total,
        page: input.page,
        pageSize: input.pageSize,
        rows,
      };
    }),

  /**
   * Promote/demote a user's platform-admin flag. Self-demotion is allowed
   * (admins can hand off), but at least one admin must remain — if the caller
   * is the last admin and tries to demote themselves, throw.
   */
  setUserAdmin: protectedProcedure
    .input(
      z.object({
        userId: z.string().cuid(),
        isAdmin: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertAdmin(ctx.session.user.id);

      if (input.userId === ctx.session.user.id && !input.isAdmin) {
        const remaining = await ctx.db.user.count({
          where: { isAdmin: true, id: { not: ctx.session.user.id } },
        });
        if (remaining === 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Cannot demote yourself — you are the last DB admin. Promote another user first.",
          });
        }
      }

      const target = await ctx.db.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true, isAdmin: true },
      });
      if (!target) throw new TRPCError({ code: "NOT_FOUND" });
      if (target.isAdmin === input.isAdmin) {
        return { ok: true, unchanged: true };
      }

      await ctx.db.user.update({
        where: { id: input.userId },
        data: { isAdmin: input.isAdmin },
      });

      await audit({
        event: input.isAdmin ? "ADMIN_USER_PROMOTED" : "ADMIN_USER_DEMOTED",
        actorUserId: ctx.session.user.id,
        subjectType: "user",
        subjectId: input.userId,
        metadata: { targetEmail: target.email },
      });

      return { ok: true, unchanged: false };
    }),

  // ────────────────────────────────────────────────────────────────────────
  // Audit log viewer
  // ────────────────────────────────────────────────────────────────────────

  recentAudit: protectedProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(200).default(50),
        event: z.string().max(64).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertAdmin(ctx.session.user.id);
      return ctx.db.auditLog.findMany({
        where: input.event
          ? {
              event:
                input.event as import("@/generated/prisma/enums").AuditEvent,
            }
          : undefined,
        orderBy: { createdAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          event: true,
          actorUserId: true,
          subjectType: true,
          subjectId: true,
          createdAt: true,
          metadata: true,
          actor: { select: { email: true, displayName: true } },
        },
      });
    }),

  // ────────────────────────────────────────────────────────────────────────
  // Guild overview
  // ────────────────────────────────────────────────────────────────────────

  listGuilds: protectedProcedure
    .input(
      z.object({
        search: z.string().trim().max(120).optional(),
        region: z.enum(["US", "EU", "KR", "TW"]).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertAdmin(ctx.session.user.id);
      return ctx.db.guild.findMany({
        where: {
          ...(input.region ? { region: input.region } : {}),
          ...(input.search
            ? {
                OR: [
                  { name: { contains: input.search, mode: "insensitive" } },
                  { guildSlug: { contains: input.search, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        orderBy: [{ name: "asc" }],
        select: {
          id: true,
          name: true,
          region: true,
          realmSlug: true,
          guildSlug: true,
          faction: true,
          claimStatus: true,
          createdAt: true,
          _count: {
            select: {
              memberships: { where: { status: "ACTIVE" } },
              raidTeams: true,
            },
          },
          claimedBy: { select: { id: true, email: true, displayName: true } },
        },
      });
    }),

  /**
   * Dashboard counters for the admin overview tab.
   */
  overview: protectedProcedure.query(async ({ ctx }) => {
    await assertAdmin(ctx.session.user.id);
    const [users, admins, guilds, raidTeams, syncRuns24h] = await Promise.all([
      ctx.db.user.count(),
      ctx.db.user.count({ where: { isAdmin: true } }),
      ctx.db.guild.count(),
      ctx.db.raidTeam.count(),
      ctx.db.syncRun.count({
        where: { startedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      }),
    ]);
    return { users, admins, guilds, raidTeams, syncRuns24h };
  }),
});
