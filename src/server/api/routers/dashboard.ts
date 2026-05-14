import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  router,
  protectedProcedure,
  assertRaidTeamRole,
} from "@/server/api/trpc";
import { normalizeRaidTeamSlug } from "@/lib/realm";
import { audit } from "@/server/security/audit";

/**
 * DashboardConfig CRUD. Only LEADER/CO_LEADER (or guild OWNER/OFFICER) may
 * mutate a dashboard; any team member may read.
 *
 * Visibility cannot be more permissive than the parent RaidTeam — the
 * setVisibility resolver enforces that.
 */

const visibilitySchema = z.enum(["TEAM", "GUILD", "LINK"]);
const layoutSchema = z.unknown();

const visRank: Record<string, number> = { TEAM: 0, GUILD: 1, LINK: 2 };

export const dashboardRouter = router({
  list: protectedProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "MEMBER");
      return ctx.db.dashboardConfig.findMany({
        where: { raidTeamId: input.raidTeamId },
        select: {
          id: true,
          name: true,
          slug: true,
          visibility: true,
          ownerUserId: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "asc" },
      });
    }),

  get: protectedProcedure
    .input(z.object({ dashboardId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const dashboard = await ctx.db.dashboardConfig.findUnique({
        where: { id: input.dashboardId },
      });
      if (!dashboard) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      await assertRaidTeamRole(ctx, dashboard.raidTeamId, "MEMBER");
      return dashboard;
    }),

  create: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        name: z.string().trim().min(2).max(80),
        layout: layoutSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "CO_LEADER");
      const slug = normalizeRaidTeamSlug(input.name);
      if (!slug) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Dashboard name must contain URL-safe characters.",
        });
      }
      const dashboard = await ctx.db.dashboardConfig.create({
        data: {
          raidTeamId: input.raidTeamId,
          ownerUserId: ctx.session.user.id,
          name: input.name,
          slug,
          layout: (input.layout ?? { widgets: [] }) as object,
        },
        select: { id: true, slug: true },
      });
      await audit({
        event: "RAID_TEAM_CREATED", // reuse for now — dedicated DASHBOARD event in follow-up
        actorUserId: ctx.session.user.id,
        subjectType: "dashboard",
        subjectId: dashboard.id,
        metadata: { raidTeamId: input.raidTeamId, name: input.name },
      });
      return dashboard;
    }),

  updateLayout: protectedProcedure
    .input(
      z.object({
        dashboardId: z.string().cuid(),
        layout: layoutSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const dashboard = await ctx.db.dashboardConfig.findUnique({
        where: { id: input.dashboardId },
        select: { raidTeamId: true },
      });
      if (!dashboard) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, dashboard.raidTeamId, "CO_LEADER");

      await ctx.db.dashboardConfig.update({
        where: { id: input.dashboardId },
        data: { layout: (input.layout ?? { widgets: [] }) as object },
      });
      return { ok: true };
    }),

  setVisibility: protectedProcedure
    .input(
      z.object({
        dashboardId: z.string().cuid(),
        visibility: visibilitySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const dashboard = await ctx.db.dashboardConfig.findUnique({
        where: { id: input.dashboardId },
        select: { raidTeamId: true },
      });
      if (!dashboard) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, dashboard.raidTeamId, "LEADER");

      // Cap visibility at the parent team's setting.
      const team = await ctx.db.raidTeam.findUnique({
        where: { id: dashboard.raidTeamId },
        select: { visibility: true },
      });
      const teamRank = visRank[team!.visibility]!;
      const inputRank = visRank[input.visibility]!;
      if (inputRank > teamRank) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Dashboard visibility cannot exceed the team's (${team!.visibility}).`,
        });
      }

      await ctx.db.dashboardConfig.update({
        where: { id: input.dashboardId },
        data: { visibility: input.visibility },
      });
      return { ok: true };
    }),

  delete: protectedProcedure
    .input(z.object({ dashboardId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const dashboard = await ctx.db.dashboardConfig.findUnique({
        where: { id: input.dashboardId },
        select: { raidTeamId: true },
      });
      if (!dashboard) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, dashboard.raidTeamId, "LEADER");
      await ctx.db.dashboardConfig.delete({ where: { id: input.dashboardId } });
      return { ok: true };
    }),
});
