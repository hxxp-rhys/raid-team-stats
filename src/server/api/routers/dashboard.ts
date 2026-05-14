import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  router,
  protectedProcedure,
  assertRaidTeamRole,
} from "@/server/api/trpc";
import { normalizeRaidTeamSlug } from "@/lib/realm";
import { audit } from "@/server/security/audit";
import { consumeLimit, policies } from "@/server/security/rate-limit";

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

  /**
   * CSV export of the dashboard's underlying audit data. Format mirrors the
   * "Eclipse Midnight" reference spreadsheet — one row per active raid-team
   * member with iLvL / M+ rating / tier pieces / missing enchants/gems /
   * last sync.
   *
   * Authorization rides on raid-team read access. Rate-limited per user
   * (1/min) — exports are cheap on the server but easy to script-pull, and
   * the audit log captures every successful export.
   */
  exportCsv: protectedProcedure
    .input(z.object({ dashboardId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const dashboard = await ctx.db.dashboardConfig.findUnique({
        where: { id: input.dashboardId },
        select: { id: true, name: true, slug: true, raidTeamId: true },
      });
      if (!dashboard) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, dashboard.raidTeamId, "MEMBER");

      const rl = await consumeLimit(policies.trpcMutationPerUser, ctx.session.user.id);
      if (!rl.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Export rate-limited. Try again shortly.",
        });
      }

      const memberships = await ctx.db.raidTeamMembership.findMany({
        where: { raidTeamId: dashboard.raidTeamId, isActive: true },
        include: {
          character: {
            select: {
              id: true,
              name: true,
              realmSlug: true,
              faction: true,
              level: true,
              lastSyncedAt: true,
            },
          },
        },
        orderBy: { addedAt: "asc" },
      });

      const characterIds = memberships.map((m) => m.character.id);
      const [equipment, mplus] = await Promise.all([
        Promise.all(
          characterIds.map((id) =>
            ctx.db.equipmentSnapshot.findFirst({
              where: { characterId: id },
              orderBy: { capturedAt: "desc" },
              select: {
                itemLevel: true,
                missingEnchantsCount: true,
                missingGemsCount: true,
                tierSetPiecesCount: true,
                capturedAt: true,
              },
            }),
          ),
        ),
        Promise.all(
          characterIds.map((id) =>
            ctx.db.mplusSnapshot.findFirst({
              where: { characterId: id },
              orderBy: { capturedAt: "desc" },
              select: { currentRating: true, weeklyHighest: true, seasonId: true },
            }),
          ),
        ),
      ]);

      const header = [
        "character",
        "realm",
        "faction",
        "level",
        "item_level",
        "tier_pieces",
        "missing_enchants",
        "missing_gems",
        "mplus_rating",
        "mplus_weekly_highest",
        "mplus_season",
        "last_synced_at",
      ];
      const rows = memberships.map((m, i) => [
        m.character.name,
        m.character.realmSlug,
        m.character.faction,
        m.character.level ?? "",
        equipment[i]?.itemLevel ?? "",
        equipment[i]?.tierSetPiecesCount ?? "",
        equipment[i]?.missingEnchantsCount ?? "",
        equipment[i]?.missingGemsCount ?? "",
        mplus[i]?.currentRating?.toString() ?? "",
        mplus[i]?.weeklyHighest ?? "",
        mplus[i]?.seasonId ?? "",
        m.character.lastSyncedAt.toISOString(),
      ]);

      const csv = [header, ...rows]
        .map((row) =>
          row
            .map((cell) => {
              const s = String(cell ?? "");
              return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            })
            .join(","),
        )
        .join("\n");

      await audit({
        event: "DASHBOARD_EXPORTED",
        actorUserId: ctx.session.user.id,
        subjectType: "dashboard",
        subjectId: dashboard.id,
        metadata: { rowCount: memberships.length },
      });

      return {
        filename: `${dashboard.slug}-${new Date().toISOString().slice(0, 10)}.csv`,
        csv,
      };
    }),
});
