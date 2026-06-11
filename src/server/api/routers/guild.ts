import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  router,
  protectedProcedure,
  assertGuildRole,
  isPlatformAdmin,
} from "@/server/api/trpc";
import { audit } from "@/server/security/audit";
import {
  GuildMemberRole,
  GuildMembershipStatus,
  type Region,
} from "@/generated/prisma/enums";
import { claimByAdmin } from "@/server/guild-auth/claim";
import { applyVerification } from "@/server/guild-auth/verify";
import {
  observeBattlenetGuilds,
  candidateKey,
} from "@/server/guild-auth/observe-battlenet";
import { normalizeRealmSlug, normalizeGuildSlug } from "@/lib/realm";
import { env } from "@/env";

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

    // Platform admins see every guild even without a membership row. Synthesize
    // entries for guilds the admin isn't already in so navigation lands on the
    // detail page (which will likewise pass the admin override).
    if (await isPlatformAdmin(ctx.session.user.id)) {
      const ownedGuildIds = new Set(memberships.map((m) => m.guildId));
      const others = await ctx.db.guild.findMany({
        where: { id: { notIn: [...ownedGuildIds] } },
        select: {
          id: true,
          region: true,
          realmSlug: true,
          guildSlug: true,
          faction: true,
          name: true,
          claimStatus: true,
        },
        orderBy: { name: "asc" },
      });
      const adminUserId = ctx.session.user.id;
      const synthetic = others.map((g) => ({
        id: `admin-synthetic-${g.id}`,
        userId: adminUserId,
        guildId: g.id,
        role: "OWNER" as const,
        status: "ACTIVE" as const,
        joinedAt: new Date(0),
        approvedAt: null,
        approvedByUserId: null,
        departedAt: null,
        guild: g,
      }));
      return [...memberships, ...synthetic];
    }

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

      const isAdmin = await isPlatformAdmin(ctx.session.user.id);
      if (!membership && !isAdmin) {
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
      // Admin without a membership row: synthesize OWNER/ACTIVE so the UI
      // renders staff-only affordances. `isAdmin` flag lets the client
      // distinguish synthesized admin access from real ownership.
      const myRole = membership?.role ?? "OWNER";
      const myStatus = membership?.status ?? "ACTIVE";
      return { guild, myRole, myStatus, isAdmin };
    }),

  /**
   * Boolean used by the guild page to decide whether to render the
   * "Settings" link. The visibility set is STRICTLY:
   *   - platform admin
   *   - guild OWNER (NOT OFFICER — they keep their other UI gates via
   *     isStaff, but the settings surface is owner-scope)
   *   - LEADER or CO_LEADER of any active raid team in this guild
   * Anyone else gets `false`. Cheap (3 small queries, short-circuited).
   */
  canManageSettings: protectedProcedure
    .input(z.object({ guildId: z.string().cuid() }))
    .query(async ({ ctx, input }): Promise<{ canManage: boolean }> => {
      if (await isPlatformAdmin(ctx.session.user.id)) {
        return { canManage: true };
      }
      const gm = await ctx.db.guildMembership.findUnique({
        where: {
          userId_guildId: {
            userId: ctx.session.user.id,
            guildId: input.guildId,
          },
        },
        select: { role: true, status: true },
      });
      if (gm?.status === "ACTIVE" && gm.role === "OWNER") {
        return { canManage: true };
      }
      const lead = await ctx.db.raidTeamMembership.findFirst({
        where: {
          isActive: true,
          role: { in: ["LEADER", "CO_LEADER"] },
          character: { userId: ctx.session.user.id },
          raidTeam: { guildId: input.guildId },
        },
        select: { id: true },
      });
      return { canManage: lead != null };
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
      if (!(await isPlatformAdmin(ctx.session.user.id))) {
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
  /**
   * Poll the state of a previously-enqueued manual roster refresh job.
   * Returns the BullMQ state ("waiting" | "active" | "completed" | "failed"
   * | "delayed" | "unknown") plus, when terminal, the relevant SyncRun
   * metrics or error message.
   *
   * Access: any active guild member. The job is identified by `jobId` returned
   * from `triggerManualSync`; passing a foreign jobId returns "unknown".
   */
  manualSyncStatus: protectedProcedure
    .input(
      z.object({
        guildId: z.string().cuid(),
        jobId: z.string().min(1).max(120),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertGuildRole(ctx, input.guildId, "MEMBER");
      // Sanity-check that the jobId actually belongs to this guild — the
      // enqueueManualRosterRefresh helper namespaces by guildId.
      if (!input.jobId.startsWith(`manual_${input.guildId}_`)) {
        return { state: "unknown" as const };
      }
      const { queues } = await import("@/server/ingestion/queues");
      const job = await queues.manualRosterRefresh.getJob(input.jobId);
      if (!job) {
        return { state: "unknown" as const };
      }
      const state = (await job.getState()) as
        | "waiting"
        | "active"
        | "completed"
        | "failed"
        | "delayed"
        | "paused"
        | "unknown"
        | "waiting-children";
      const out: {
        state: typeof state;
        attemptsMade: number;
        startedAt: number | null;
        finishedAt: number | null;
        returnValue: unknown;
        failedReason: string | null;
      } = {
        state,
        attemptsMade: job.attemptsMade,
        startedAt: job.processedOn ?? null,
        finishedAt: job.finishedOn ?? null,
        returnValue: state === "completed" ? job.returnvalue : null,
        failedReason: state === "failed" ? job.failedReason ?? null : null,
      };
      return out;
    }),

  triggerManualSync: protectedProcedure
    .input(z.object({ guildId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertGuildRole(ctx, input.guildId, "MEMBER");

      // Defer the actual import to avoid bundling BullMQ into client-facing
      // tRPC handlers when it's not strictly needed.
      const { enqueueManualRosterRefresh } = await import(
        "@/server/ingestion/jobs/manual-roster-refresh"
      );
      const result = await enqueueManualRosterRefresh(
        {
          guildId: input.guildId,
          triggeredByUserId: ctx.session.user.id,
        },
        { bypassRateLimit: await isPlatformAdmin(ctx.session.user.id) },
      );

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
    // Full discover-and-add. Used by the on-link auto-discovery redirect
    // (?bnet=linked). Observes every Battle.net character and applies the
    // result with the normal absence sweep + GM auto-claim. The selective
    // "Add Guild" lightbox uses the candidate/add pair below instead.
    const { observations } = await observeBattlenetGuilds(ctx.session.user.id);

    const result = await applyVerification({
      userId: ctx.session.user.id,
      observedAt: new Date(),
      characters: observations,
      // OAuth proved the caller owns these characters → re-attribute any
      // existing Character rows and run the pending-asset claim sweep.
      verifiedOwnership: true,
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
      pendingTeamsClaimed: result.pendingTeamsClaimed,
      pendingDashboardsClaimed: result.pendingDashboardsClaimed,
    };
  }),

  /**
   * Step 1 of the "Add Guild" lightbox. Observes the caller's Battle.net
   * characters and returns the DISTINCT guilds found, WITHOUT writing
   * anything (no Character upsert, no membership, no claim). Each candidate
   * carries an opaque `key` the client passes back to `addDiscoveredGuilds`.
   *
   * `alreadyMember` lets the UI disable guilds the user already belongs to;
   * `isGuildMaster` lets it warn "you are GM — adding will claim ownership".
   */
  discoverGuildCandidates: protectedProcedure.mutation(async ({ ctx }) => {
    const { observations, charactersObserved } = await observeBattlenetGuilds(
      ctx.session.user.id,
    );

    // Collapse observations to distinct guilds (a user may have several
    // characters in one guild). `isGM` is true if ANY of the user's chars in
    // that guild is rosterRank 0.
    type Cand = {
      key: string;
      name: string;
      region: string;
      realmSlug: string;
      faction: string;
      guildSlug: string;
      isGuildMaster: boolean;
    };
    const distinct = new Map<string, Cand>();
    for (const obs of observations) {
      if (!obs.guild) continue;
      const gRealm = normalizeRealmSlug(obs.guild.realmSlug);
      const gSlug = normalizeGuildSlug(obs.guild.name);
      if (!gRealm || !gSlug) continue;
      const key = candidateKey(obs.region, gRealm, gSlug);
      const isGM = obs.guild.rosterRank === 0;
      const existing = distinct.get(key);
      if (!existing) {
        distinct.set(key, {
          key,
          name: obs.guild.name,
          region: obs.region,
          realmSlug: gRealm,
          faction: obs.guild.faction,
          guildSlug: gSlug,
          isGuildMaster: isGM,
        });
      } else if (isGM) {
        existing.isGuildMaster = true;
      }
    }

    // Annotate each candidate with the caller's existing membership status
    // (read-only). Guild rows may not exist yet on a first-ever discovery.
    const candidates = await Promise.all(
      [...distinct.values()].map(async (c) => {
        const guildRow = await ctx.db.guild.findUnique({
          where: {
            region_realmSlug_guildSlug: {
              region: c.region as Region,
              realmSlug: c.realmSlug,
              guildSlug: c.guildSlug,
            },
          },
          select: { id: true },
        });
        let membershipStatus: GuildMembershipStatus | null = null;
        if (guildRow) {
          const m = await ctx.db.guildMembership.findUnique({
            where: {
              userId_guildId: {
                userId: ctx.session.user.id,
                guildId: guildRow.id,
              },
            },
            select: { status: true },
          });
          membershipStatus = m?.status ?? null;
        }
        return {
          key: c.key,
          name: c.name,
          region: c.region,
          realmSlug: c.realmSlug,
          faction: c.faction,
          isGuildMaster: c.isGuildMaster,
          alreadyMember:
            membershipStatus === "ACTIVE" || membershipStatus === "PENDING",
          membershipStatus,
        };
      }),
    );

    // Stable order: alphabetical by guild name.
    candidates.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

    return { ok: true, charactersObserved, candidates };
  }),

  /**
   * Step 2 of the "Add Guild" lightbox. Adds ONLY the guilds the user ticked.
   *
   * SECURITY: re-derives the full observation set from the caller's own
   * Battle.net OAuth token (never trusts the client). The `guildKeys` list is
   * used purely as a filter — a key not in the re-derived set is silently
   * dropped, so a forged key is a no-op. Passes `skipAbsenceSweep: true` so
   * the FILTERED observation set can't be read as "every other guild is
   * absent" (which would march untracked-this-call guilds toward departure).
   */
  addDiscoveredGuilds: protectedProcedure
    .input(
      z.object({
        guildKeys: z.array(z.string().min(1).max(256)).min(1).max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { observations } = await observeBattlenetGuilds(ctx.session.user.id);
      const requested = new Set(input.guildKeys);

      // Keep only observations whose guild was both re-derived from OAuth AND
      // ticked by the user. No guild → nothing to add.
      const addedKeys = new Set<string>();
      const filtered = observations.filter((o) => {
        if (!o.guild) return false;
        const gRealm = normalizeRealmSlug(o.guild.realmSlug);
        const gSlug = normalizeGuildSlug(o.guild.name);
        if (!gRealm || !gSlug) return false;
        const key = candidateKey(o.region, gRealm, gSlug);
        if (!requested.has(key)) return false;
        addedKeys.add(key);
        return true;
      });

      if (filtered.length === 0) {
        return {
          ok: true,
          added: 0,
          guildsMatched: 0,
          autoClaims: 0,
        };
      }

      const result = await applyVerification({
        userId: ctx.session.user.id,
        observedAt: new Date(),
        characters: filtered,
        verifiedOwnership: true,
        // CRITICAL: filtered subset — never run the absence sweep here.
        skipAbsenceSweep: true,
      });

      await audit({
        event: "SYNC_TRIGGERED",
        actorUserId: ctx.session.user.id,
        subjectType: "user",
        subjectId: ctx.session.user.id,
        metadata: {
          tier: "add_discovered_guilds",
          addedKeys: [...addedKeys],
          ...result,
        },
      });

      return {
        ok: true,
        added: addedKeys.size,
        guildsMatched: result.guildMatches,
        autoClaims: result.autoClaims,
      };
    }),

  /**
   * Permanently delete a guild. High blast radius (per Prisma schema):
   *   GuildMembership rows → Cascade
   *   GuildCharacterLink rows → Cascade
   *   RaidTeam rows → Cascade (which cascades RaidTeamMembership + DashboardConfig)
   *   Guild.claimedByUserId → SetNull (already)
   *
   * Gated to OWNER only (NOT OFFICER) or platform admin. Type-the-name
   * confirm guards against wrong-entity deletes. Reuses
   * GUILD_ROLE_CHANGED with metadata.action="deleted" until we get a
   * dedicated GUILD_DELETED audit event (NEXT_STEPS.md #5).
   */
  delete: protectedProcedure
    .input(
      z.object({
        guildId: z.string().cuid(),
        confirmName: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertGuildRole(ctx, input.guildId, "OWNER");
      const guild = await ctx.db.guild.findUnique({
        where: { id: input.guildId },
        select: { id: true, name: true },
      });
      if (!guild) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Guild not found.",
        });
      }
      if (input.confirmName.trim() !== guild.name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Confirmation does not match the guild's name.",
        });
      }
      await ctx.db.guild.delete({ where: { id: guild.id } });
      await audit({
        event: "GUILD_ROLE_CHANGED",
        actorUserId: ctx.session.user.id,
        subjectType: "guild",
        subjectId: input.guildId,
        metadata: { action: "deleted", guildName: guild.name },
      });
      return { ok: true };
    }),

});
