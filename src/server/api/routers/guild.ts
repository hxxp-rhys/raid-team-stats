import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  router,
  protectedProcedure,
  assertGuildRole,
} from "@/server/api/trpc";
import { audit } from "@/server/security/audit";
import { GuildMemberRole, GuildMembershipStatus } from "@/generated/prisma/enums";
import { claimByAdmin } from "@/server/guild-auth/claim";
import { env } from "@/env";
import {
  getPublicStatus as getWowauditPublicStatus,
  setConfig as setWowauditConfigStore,
  clearConfig as clearWowauditConfigStore,
  DEFAULT_WOWAUDIT_BASE_URL,
} from "@/server/ingestion/wowaudit/config";
import { WowauditClient } from "@/server/ingestion/wowaudit/client";

const memberRoleSchema = z.enum(["MEMBER", "OFFICER", "OWNER"]);

export const guildRouter = router({
  /**
   * Guilds the caller has any membership in (including PENDING / DEPARTED).
   * Used by /guild list page.
   */
  myGuilds: protectedProcedure.query(async ({ ctx }) => {
    const memberships = await ctx.db.guildMembership.findMany({
      where: { userId: ctx.session.user.id },
      include: {
        guild: {
          select: {
            id: true,
            region: true,
            realmSlug: true,
            guildSlug: true,
            faction: true,
            name: true,
            claimStatus: true,
          },
        },
      },
      orderBy: { joinedAt: "desc" },
    });
    return memberships;
  }),

  /**
   * Guild detail page. Only returns data if the caller has any membership
   * (ACTIVE, PENDING, or DEPARTED — DEPARTED users may still see history).
   */
  get: protectedProcedure
    .input(z.object({ guildId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const membership = await ctx.db.guildMembership.findUnique({
        where: {
          userId_guildId: {
            userId: ctx.session.user.id,
            guildId: input.guildId,
          },
        },
        select: { role: true, status: true },
      });
      if (!membership) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const guild = await ctx.db.guild.findUnique({
        where: { id: input.guildId },
        include: {
          memberships: {
            include: {
              user: {
                select: { id: true, displayName: true, email: true },
              },
            },
            orderBy: { joinedAt: "desc" },
          },
          raidTeams: {
            select: {
              id: true,
              name: true,
              slug: true,
              visibility: true,
              leaderUserId: true,
              _count: {
                select: { memberships: { where: { isActive: true } } },
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      });
      if (!guild) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return { guild, myRole: membership.role, myStatus: membership.status };
    }),

  /**
   * Guild OWNER / OFFICER approves a PENDING member.
   */
  approveMember: protectedProcedure
    .input(
      z.object({
        guildId: z.string().cuid(),
        userId: z.string().cuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertGuildRole(ctx, input.guildId, "OFFICER");

      const updated = await ctx.db.guildMembership.updateMany({
        where: {
          guildId: input.guildId,
          userId: input.userId,
          status: GuildMembershipStatus.PENDING,
        },
        data: {
          status: GuildMembershipStatus.ACTIVE,
          approvedAt: new Date(),
          approvedByUserId: ctx.session.user.id,
        },
      });
      if (updated.count === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No pending membership found for that user.",
        });
      }

      await audit({
        event: "MEMBER_APPROVED",
        actorUserId: ctx.session.user.id,
        subjectType: "user",
        subjectId: input.userId,
        metadata: { guildId: input.guildId },
      });
      return { ok: true };
    }),

  /**
   * Guild OWNER promotes / demotes another member (cannot change one's own
   * role; cannot demote the sole OWNER — handled by an explicit
   * transferOwnership endpoint in a follow-up).
   *
   * MFA-gated escalation: target users being promoted to OWNER must have
   * `mfaEnabled` first. Officers can be elevated without MFA (lower blast
   * radius); the policy can tighten later by changing the role threshold.
   */
  setMemberRole: protectedProcedure
    .input(
      z.object({
        guildId: z.string().cuid(),
        userId: z.string().cuid(),
        role: memberRoleSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertGuildRole(ctx, input.guildId, "OWNER");
      if (input.userId === ctx.session.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Use transferOwnership to demote yourself.",
        });
      }
      if (input.role === "OWNER") {
        const target = await ctx.db.user.findUnique({
          where: { id: input.userId },
          select: { mfaEnabled: true, email: true },
        });
        if (!target) throw new TRPCError({ code: "NOT_FOUND" });
        if (!target.mfaEnabled) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `${target.email} must enable two-factor authentication before being promoted to OWNER.`,
          });
        }
      }
      await ctx.db.guildMembership.update({
        where: {
          userId_guildId: { userId: input.userId, guildId: input.guildId },
        },
        data: { role: input.role as GuildMemberRole },
      });
      await audit({
        event: "GUILD_ROLE_CHANGED",
        actorUserId: ctx.session.user.id,
        subjectType: "user",
        subjectId: input.userId,
        metadata: { guildId: input.guildId, newRole: input.role },
      });
      return { ok: true };
    }),

  /**
   * Platform-admin fallback claim: only available to user IDs listed in
   * env.ADMIN_USER_IDS. Used when no GM has registered within 14 days.
   */
  adminClaim: protectedProcedure
    .input(
      z.object({
        guildId: z.string().cuid(),
        newOwnerUserId: z.string().cuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const isAdmin = env.ADMIN_USER_IDS.includes(ctx.session.user.id);
      if (!isAdmin) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      return claimByAdmin({
        guildId: input.guildId,
        newOwnerUserId: input.newOwnerUserId,
        adminUserId: ctx.session.user.id,
      });
    }),

  /**
   * Trigger a manual roster refresh for a guild. Rate-limited (1/5min per
   * guild, 1/10min per user) — enforced inside the queued job. The job runs
   * inside the BullMQ worker process; this mutation just enqueues it.
   */
  triggerManualSync: protectedProcedure
    .input(z.object({ guildId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertGuildRole(ctx, input.guildId, "MEMBER");

      // Defer the actual import to avoid bundling BullMQ into client-facing
      // tRPC handlers when it's not strictly needed.
      const { enqueueManualRosterRefresh } = await import(
        "@/server/ingestion/jobs/manual-roster-refresh"
      );
      const result = await enqueueManualRosterRefresh({
        guildId: input.guildId,
        triggeredByUserId: ctx.session.user.id,
      });

      await audit({
        event: "SYNC_TRIGGERED",
        actorUserId: ctx.session.user.id,
        subjectType: "guild",
        subjectId: input.guildId,
        metadata: { tier: "manual" },
      });
      return result;
    }),

  /**
   * Pull the caller's character list from Battle.net and run the verification
   * pipeline. Requires the caller to have linked their Battle.net account.
   * Used by the "Discover my guilds" button on /profile.
   */
  discoverFromBattlenet: protectedProcedure.mutation(async ({ ctx }) => {
    const account = await ctx.db.account.findFirst({
      where: { userId: ctx.session.user.id, provider: "battlenet" },
      select: { access_token: true, expires_at: true },
    });
    if (!account?.access_token) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Link your Battle.net account on the profile page first.",
      });
    }

    const { blizzardClient } = await import("@/server/ingestion/blizzard/client");
    const { endpoints } = await import("@/server/ingestion/blizzard/endpoints");
    const { userCharactersResponseSchema, characterSummaryResponseSchema, FACTION_MAP } =
      await import("@/server/ingestion/blizzard/schemas");
    const { normalizeRealmSlug } = await import("@/lib/realm");
    const { applyVerification } = await import("@/server/guild-auth/verify");

    const region = env.BLIZZARD_REGION;
    const client = blizzardClient();
    const characters = await client.request(endpoints.userCharacters(region), {
      region,
      schema: userCharactersResponseSchema,
      auth: { kind: "user", accessToken: account.access_token },
    });

    type Faction = "ALLIANCE" | "HORDE" | "NEUTRAL";
    const factionFromRaw = (raw: string | undefined, fallback: Faction): Faction =>
      raw ? ((FACTION_MAP[raw] ?? fallback) as Faction) : fallback;

    const observations = [];
    for (const wowAccount of characters.wow_accounts) {
      for (const c of wowAccount.characters) {
        const realmSlug = normalizeRealmSlug(c.realm.slug);
        if (!realmSlug) continue;
        try {
          const summary = await client.request(
            endpoints.characterSummary(region, realmSlug, c.name),
            {
              region,
              schema: characterSummaryResponseSchema,
              auth: { kind: "app" },
            },
          );
          const charFaction = factionFromRaw(summary.faction?.type, "ALLIANCE");
          observations.push({
            blizzardCharacterId: c.id,
            region: region.toUpperCase() as "US" | "EU" | "KR" | "TW",
            realmSlug,
            characterName: c.name,
            faction: charFaction,
            level: summary.level ?? c.level ?? null,
            classId: summary.character_class?.id ?? c.playable_class?.id ?? null,
            race: undefined,
            guild: summary.guild
              ? {
                  name: summary.guild.name,
                  realmSlug: summary.guild.realm.slug,
                  faction: factionFromRaw(summary.guild.faction?.type, charFaction),
                  rosterRank: null,
                }
              : null,
          });
        } catch {
          // Skip transient per-character failures — they'll be picked up on
          // the next sync.
        }
      }
    }

    const result = await applyVerification({
      userId: ctx.session.user.id,
      observedAt: new Date(),
      characters: observations,
    });

    await audit({
      event: "SYNC_TRIGGERED",
      actorUserId: ctx.session.user.id,
      subjectType: "user",
      subjectId: ctx.session.user.id,
      metadata: { tier: "battlenet_discover", ...result },
    });

    return {
      ok: true,
      charactersObserved: observations.length,
      guildsMatched: result.guildMatches,
      autoClaims: result.autoClaims,
    };
  }),

  // ────────────────────────────────────────────────────────────────────────
  // WoW Audit integration (per-guild API key, encrypted at rest)
  //
  // Reads: any ACTIVE guild member can see whether WoW Audit is configured
  // and a 4-char hint of the key, but never the raw key.
  // Writes: OFFICER+ only. Each write is audit-logged.
  // ────────────────────────────────────────────────────────────────────────

  wowauditStatus: protectedProcedure
    .input(z.object({ guildId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertGuildRole(ctx, input.guildId, "MEMBER");
      const status = await getWowauditPublicStatus(input.guildId);
      return { ...status, defaultBaseUrl: DEFAULT_WOWAUDIT_BASE_URL };
    }),

  setWowauditConfig: protectedProcedure
    .input(
      z.object({
        guildId: z.string().cuid(),
        apiKey: z.string().trim().min(8).max(512),
        teamId: z.string().trim().max(64).optional(),
        baseUrl: z.string().url().max(256).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertGuildRole(ctx, input.guildId, "OFFICER");
      await setWowauditConfigStore(input.guildId, {
        apiKey: input.apiKey,
        teamId: input.teamId ?? null,
        baseUrl: input.baseUrl ?? null,
      });
      await audit({
        event: "GUILD_ROLE_CHANGED", // reuse for now; consider dedicated event
        actorUserId: ctx.session.user.id,
        subjectType: "guild",
        subjectId: input.guildId,
        metadata: {
          action: "wowaudit_configured",
          teamId: input.teamId ?? null,
          baseUrl: input.baseUrl ?? null,
        },
      });
      return { ok: true };
    }),

  clearWowauditConfig: protectedProcedure
    .input(z.object({ guildId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertGuildRole(ctx, input.guildId, "OFFICER");
      await clearWowauditConfigStore(input.guildId);
      await audit({
        event: "GUILD_ROLE_CHANGED",
        actorUserId: ctx.session.user.id,
        subjectType: "guild",
        subjectId: input.guildId,
        metadata: { action: "wowaudit_cleared" },
      });
      return { ok: true };
    }),

  testWowauditConnection: protectedProcedure
    .input(z.object({ guildId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertGuildRole(ctx, input.guildId, "OFFICER");
      const client = await WowauditClient.forGuild(input.guildId);
      if (!client) {
        return { ok: false as const, error: "No WoW Audit key configured." };
      }
      return client.ping();
    }),
});
