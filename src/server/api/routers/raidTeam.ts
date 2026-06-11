import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  router,
  protectedProcedure,
  assertGuildRole,
  assertRaidTeamRole,
  isPlatformAdmin,
} from "@/server/api/trpc";
import { normalizeRaidTeamSlug } from "@/lib/realm";
import { audit } from "@/server/security/audit";
import { enqueueImmediateCharacterSync } from "@/server/ingestion/jobs/tracked-member-sync";

const nameSchema = z.string().trim().min(2).max(60);
const visibilitySchema = z.enum(["TEAM", "GUILD", "LINK"]);
const teamRoleSchema = z.enum(["MEMBER", "CO_LEADER"]);

// Discriminated union for the recurring auto-refresh schedule. Persisted as
// JSON on RaidTeam.refreshSchedule. `null` = no recurring schedule.
const intervalHourSchema = z.union([
  z.literal(4),
  z.literal(6),
  z.literal(12),
  z.literal(24),
  z.literal(28),
  z.literal(72),
]);
export const refreshScheduleSchema = z.union([
  z.object({ kind: z.literal("interval"), hours: intervalHourSchema }),
  z.object({
    kind: z.literal("weekly"),
    dayOfWeek: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.null(),
]);
export type RefreshSchedule = z.infer<typeof refreshScheduleSchema>;

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

  /**
   * Characters in the team's guild that are eligible to be added: ACTIVE
   * guildCharacterLink and not already on another active team in this guild.
   * Used by the team-management UI's "Add member" picker.
   */
  eligibleCharacters: protectedProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const { guildId } = await assertRaidTeamRole(ctx, input.raidTeamId, "CO_LEADER");

      const links = await ctx.db.guildCharacterLink.findMany({
        where: { guildId, status: "ACTIVE" },
        select: {
          character: {
            select: {
              id: true,
              name: true,
              realmSlug: true,
              region: true,
              level: true,
              classId: true,
              raidMemberships: {
                where: { isActive: true, raidTeam: { guildId } },
                select: { raidTeamId: true },
              },
            },
          },
        },
        orderBy: { character: { name: "asc" } },
      });

      // Eligible = active GuildCharacterLink AND not on any active team in
      // this guild. (Characters already on this team show up under "Members"
      // on the team page; re-adding from the picker would be a no-op.)
      return links
        .map((l) => l.character)
        .filter((c) => c.raidMemberships.length === 0)
        .map((c) => ({
          id: c.id,
          name: c.name,
          realmSlug: c.realmSlug,
          region: c.region,
          level: c.level,
          classId: c.classId,
        }));
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

      // Kick off an immediate per-character sync so the newly-added character
      // appears in the team's widgets without waiting up to an hour for the
      // next tier-A pass. Fire-and-forget; failures just mean the next
      // scheduled sync picks them up.
      void enqueueImmediateCharacterSync(input.characterId, "added_to_team");

      return { ok: true, membershipId: membership.id };
    }),

  /**
   * Permanently delete a raid team. Cascades (per Prisma schema):
   *   RaidTeamMembership rows → Cascade
   *   DashboardConfig rows → Cascade
   *   (RaidTeam.leaderUserId / pendingLeaderCharacterId → SetNull)
   *
   * Gated to LEADER on the team OR guild OWNER/OFFICER OR platform admin via
   * the existing assertRaidTeamRole helper. Type-the-name confirm guards
   * against wrong-entity deletes (e.g. an admin holding two team detail
   * pages open). Reuses RAID_TEAM_SETTINGS_UPDATED with metadata.action
   * until we get dedicated *_DELETED audit events (NEXT_STEPS.md #5).
   */
  delete: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        confirmName: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guildId } = await assertRaidTeamRole(
        ctx,
        input.raidTeamId,
        "LEADER",
      );
      const team = await ctx.db.raidTeam.findUnique({
        where: { id: input.raidTeamId },
        select: { id: true, name: true },
      });
      if (!team) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Raid team not found.",
        });
      }
      if (input.confirmName.trim() !== team.name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Confirmation does not match the team's name.",
        });
      }
      await ctx.db.raidTeam.delete({ where: { id: team.id } });
      await audit({
        event: "RAID_TEAM_SETTINGS_UPDATED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidTeam",
        subjectId: input.raidTeamId,
        metadata: { action: "deleted", teamName: team.name, guildId },
      });
      return { ok: true };
    }),

  // ────────────────────────────────────────────────────────────────────────
  // Team-level refresh + schedule controls
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Read the refresh settings + last-refresh timestamp. Visible to any active
   * team member so the data_refresh widget can render its state.
   */
  refreshSettings: protectedProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "MEMBER");
      const team = await ctx.db.raidTeam.findUnique({
        where: { id: input.raidTeamId },
        select: {
          memberCanRefresh: true,
          refreshSchedule: true,
          lastRefreshAt: true,
        },
      });
      if (!team) throw new TRPCError({ code: "NOT_FOUND" });
      // Validate stored shape; if it's malformed (manual DB edit, old shape),
      // return null instead of throwing — UI treats null as "no schedule".
      const parsed = refreshScheduleSchema.safeParse(team.refreshSchedule);
      return {
        memberCanRefresh: team.memberCanRefresh,
        refreshSchedule: parsed.success ? parsed.data : null,
        lastRefreshAt: team.lastRefreshAt,
      };
    }),

  /**
   * Live progress for an in-flight manual refresh. `since` is the timestamp
   * the refresh batch was enqueued (returned as `at` by triggerTeamRefresh).
   * A character counts as synced once its `lastSyncedAt` advances to/after
   * that baseline (set by the trackedMemberSync job on completion). Visible
   * to any active member so the data_refresh widget can poll it.
   */
  syncProgress: protectedProcedure
    .input(
      z.object({ raidTeamId: z.string().cuid(), since: z.date() }),
    )
    .query(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "MEMBER");
      const memberships = await ctx.db.raidTeamMembership.findMany({
        where: { raidTeamId: input.raidTeamId, isActive: true },
        select: { character: { select: { lastSyncedAt: true } } },
      });
      const total = memberships.length;
      const synced = memberships.reduce(
        (n, m) =>
          m.character.lastSyncedAt != null &&
          m.character.lastSyncedAt >= input.since
            ? n + 1
            : n,
        0,
      );
      return { total, synced };
    }),

  /**
   * Leader / co-leader (or guild OWNER/OFFICER, or admin) updates the team's
   * member-can-refresh flag and recurring refresh schedule.
   */
  setRefreshSettings: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        memberCanRefresh: z.boolean().optional(),
        refreshSchedule: refreshScheduleSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "CO_LEADER");
      const { Prisma } = await import("@/generated/prisma/client");
      // Prisma's JSON column accepts a non-null value or Prisma.JsonNull (a
      // sentinel that becomes SQL `JSON null`). `undefined` keeps the column
      // unchanged. We map: schedule === null → Prisma.JsonNull, schedule
      // object → the object itself, schedule undefined → don't include the
      // key at all.
      const data: Record<string, unknown> = {};
      if (typeof input.memberCanRefresh === "boolean") {
        data.memberCanRefresh = input.memberCanRefresh;
      }
      if (input.refreshSchedule !== undefined) {
        data.refreshSchedule =
          input.refreshSchedule === null
            ? Prisma.JsonNull
            : input.refreshSchedule;
      }
      if (Object.keys(data).length === 0) {
        return { ok: true, unchanged: true };
      }
      await ctx.db.raidTeam.update({
        where: { id: input.raidTeamId },
        data,
      });
      await audit({
        event: "RAID_TEAM_SETTINGS_UPDATED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidTeam",
        subjectId: input.raidTeamId,
        metadata: {
          memberCanRefresh:
            data.memberCanRefresh as boolean | undefined,
          refreshSchedule: input.refreshSchedule ?? null,
        },
      });
      return { ok: true, unchanged: false };
    }),

  /**
   * Trigger a Tier-A re-sync for every active member of the team.
   *
   * Permissions:
   *  - CO_LEADER+ (or guild OWNER/OFFICER, or admin) always allowed.
   *  - Regular team MEMBERs allowed only when `memberCanRefresh` is true.
   *  - Non-members denied with NOT_FOUND.
   */
  triggerTeamRefresh: protectedProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const team = await ctx.db.raidTeam.findUnique({
        where: { id: input.raidTeamId },
        select: { id: true, guildId: true, memberCanRefresh: true },
      });
      if (!team) throw new TRPCError({ code: "NOT_FOUND" });

      const admin = await isPlatformAdmin(userId);
      let allowed = admin;

      if (!allowed) {
        // Guild OWNER/OFFICER override
        const gm = await ctx.db.guildMembership.findUnique({
          where: { userId_guildId: { userId, guildId: team.guildId } },
          select: { role: true, status: true },
        });
        if (
          gm?.status === "ACTIVE" &&
          (gm.role === "OWNER" || gm.role === "OFFICER")
        ) {
          allowed = true;
        }
      }

      let elevated = allowed;
      if (!allowed) {
        // Team-level role
        const tm = await ctx.db.raidTeamMembership.findFirst({
          where: {
            raidTeamId: input.raidTeamId,
            isActive: true,
            character: { userId },
          },
          select: { role: true },
        });
        if (!tm) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        if (tm.role === "LEADER" || tm.role === "CO_LEADER") {
          allowed = true;
          elevated = true;
        } else if (team.memberCanRefresh) {
          allowed = true;
        }
      }

      if (!allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only raid leaders can refresh this team's data. Ask a leader to enable member refresh.",
        });
      }

      const { enqueueTeamRefresh } = await import(
        "@/server/ingestion/jobs/team-refresh"
      );
      const result = await enqueueTeamRefresh(
        { raidTeamId: input.raidTeamId, triggeredByUserId: userId, source: "manual" },
        { bypassRateLimit: elevated && admin },
      );

      await audit({
        event: "SYNC_TRIGGERED",
        actorUserId: userId,
        subjectType: "raidTeam",
        subjectId: input.raidTeamId,
        metadata: { tier: "team_manual", elevated },
      });

      return result;
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
