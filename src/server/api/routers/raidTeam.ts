import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  router,
  protectedProcedure,
  assertGuildRole,
  assertRaidTeamRole,
} from "@/server/api/trpc";
import { normalizeRaidTeamSlug } from "@/lib/realm";
import { audit } from "@/server/security/audit";

const nameSchema = z.string().trim().min(2).max(60);
const visibilitySchema = z.enum(["TEAM", "GUILD", "LINK"]);
const teamRoleSchema = z.enum(["MEMBER", "CO_LEADER"]);

export const raidTeamRouter = router({
  /**
   * Full team detail (settings + active member list with character info).
   * Used by /guild/[guildId]/team/[teamId] page.
   */
  get: protectedProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "MEMBER");
      const team = await ctx.db.raidTeam.findUnique({
        where: { id: input.raidTeamId },
        include: {
          memberships: {
            where: { isActive: true },
            include: {
              character: {
                select: {
                  id: true,
                  name: true,
                  realmSlug: true,
                  region: true,
                  faction: true,
                  classId: true,
                  level: true,
                  lastSyncedAt: true,
                  userId: true,
                },
              },
            },
            orderBy: { addedAt: "asc" },
          },
          guild: { select: { id: true, name: true, region: true } },
        },
      });
      if (!team) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return team;
    }),

  /**
   * Returns the raid teams the caller can see in a given guild.
   * - Guild OWNER/OFFICER sees every team.
   * - A team member sees their own team(s).
   * - Other guild members see teams whose visibility is GUILD or LINK.
   */
  list: protectedProcedure
    .input(z.object({ guildId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      // Must at least be an active guild member.
      await assertGuildRole(ctx, input.guildId, "MEMBER");

      const teams = await ctx.db.raidTeam.findMany({
        where: { guildId: input.guildId },
        select: {
          id: true,
          name: true,
          slug: true,
          visibility: true,
          leaderUserId: true,
          createdAt: true,
          _count: { select: { memberships: { where: { isActive: true } } } },
        },
        orderBy: { createdAt: "asc" },
      });

      // Determine the caller's overrides.
      const isStaff = (
        await ctx.db.guildMembership.findUnique({
          where: {
            userId_guildId: {
              userId: ctx.session.user.id,
              guildId: input.guildId,
            },
          },
          select: { role: true },
        })
      )?.role;
      const staffOverride = isStaff === "OWNER" || isStaff === "OFFICER";

      if (staffOverride) return teams;

      // Filter for non-staff: include only GUILD/LINK or teams the caller is on.
      const myTeamIds = new Set(
        (
          await ctx.db.raidTeamMembership.findMany({
            where: {
              isActive: true,
              character: { userId: ctx.session.user.id },
              raidTeam: { guildId: input.guildId },
            },
            select: { raidTeamId: true },
          })
        ).map((m) => m.raidTeamId),
      );

      return teams.filter(
        (t) =>
          t.visibility === "GUILD" || t.visibility === "LINK" || myTeamIds.has(t.id),
      );
    }),

  create: protectedProcedure
    .input(
      z.object({
        guildId: z.string().cuid(),
        name: nameSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertGuildRole(ctx, input.guildId, "OFFICER");

      const slug = normalizeRaidTeamSlug(input.name);
      if (!slug) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Team name must contain at least one URL-safe character.",
        });
      }

      const team = await ctx.db.raidTeam.create({
        data: {
          guildId: input.guildId,
          name: input.name,
          slug,
          leaderUserId: ctx.session.user.id,
        },
        select: { id: true, slug: true, name: true },
      });

      await audit({
        event: "RAID_TEAM_CREATED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidTeam",
        subjectId: team.id,
        metadata: { guildId: input.guildId, name: input.name },
      });

      return team;
    }),

  setVisibility: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        visibility: visibilitySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "LEADER");
      await ctx.db.raidTeam.update({
        where: { id: input.raidTeamId },
        data: { visibility: input.visibility },
      });
      return { ok: true };
    }),

  transferLeadership: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        newLeaderUserId: z.string().cuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guildId } = await assertRaidTeamRole(ctx, input.raidTeamId, "LEADER");

      // New leader must be an ACTIVE guild member.
      const target = await ctx.db.guildMembership.findUnique({
        where: {
          userId_guildId: { userId: input.newLeaderUserId, guildId },
        },
        select: { status: true },
      });
      if (!target || target.status !== "ACTIVE") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "New leader must be an active member of the guild.",
        });
      }

      await ctx.db.raidTeam.update({
        where: { id: input.raidTeamId },
        data: { leaderUserId: input.newLeaderUserId },
      });

      await audit({
        event: "RAID_TEAM_LEADERSHIP_TRANSFERRED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidTeam",
        subjectId: input.raidTeamId,
        metadata: { newLeaderUserId: input.newLeaderUserId },
      });

      return { ok: true };
    }),

  addMember: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        characterId: z.string().cuid(),
        role: teamRoleSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guildId } = await assertRaidTeamRole(ctx, input.raidTeamId, "CO_LEADER");

      const character = await ctx.db.character.findUnique({
        where: { id: input.characterId },
        select: {
          id: true,
          userId: true,
          guildLinks: {
            where: { guildId, status: "ACTIVE" },
            select: { id: true },
          },
        },
      });
      if (!character || character.guildLinks.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Character is not an active member of this guild.",
        });
      }

      // A character can be on only one active raid team per guild — enforce
      // before insert to give a clean error message.
      const conflict = await ctx.db.raidTeamMembership.findFirst({
        where: {
          characterId: input.characterId,
          isActive: true,
          raidTeam: { guildId },
        },
        select: { raidTeamId: true },
      });
      if (conflict && conflict.raidTeamId !== input.raidTeamId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This character is already on another raid team in this guild.",
        });
      }

      const membership = await ctx.db.raidTeamMembership.upsert({
        where: {
          raidTeamId_characterId: {
            raidTeamId: input.raidTeamId,
            characterId: input.characterId,
          },
        },
        create: {
          raidTeamId: input.raidTeamId,
          characterId: input.characterId,
          role: input.role ?? "MEMBER",
          addedByUserId: ctx.session.user.id,
        },
        update: {
          isActive: true,
          removedAt: null,
          removalReason: null,
          role: input.role ?? "MEMBER",
          addedByUserId: ctx.session.user.id,
        },
        select: { id: true, role: true },
      });

      await audit({
        event: "RAID_TEAM_MEMBER_ADDED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidTeam",
        subjectId: input.raidTeamId,
        metadata: { characterId: input.characterId, role: membership.role },
      });

      return { ok: true, membershipId: membership.id };
    }),

  removeMember: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        characterId: z.string().cuid(),
        reason: z.string().max(120).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "CO_LEADER");

      const result = await ctx.db.raidTeamMembership.updateMany({
        where: {
          raidTeamId: input.raidTeamId,
          characterId: input.characterId,
          isActive: true,
        },
        data: {
          isActive: false,
          removedAt: new Date(),
          removalReason: input.reason ?? "removed_by_team_lead",
        },
      });
      if (result.count === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That character is not currently on this team.",
        });
      }

      await audit({
        event: "RAID_TEAM_MEMBER_REMOVED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidTeam",
        subjectId: input.raidTeamId,
        metadata: { characterId: input.characterId, reason: input.reason },
      });

      return { ok: true };
    }),
});
