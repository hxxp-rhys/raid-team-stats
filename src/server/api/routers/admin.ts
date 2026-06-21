import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  router,
  protectedProcedure,
  isPlatformAdmin,
} from "@/server/api/trpc";
import { audit } from "@/server/security/audit";
import { emailBlindIndex } from "@/server/auth/email-index";

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
        // Email is encrypted at rest, so substring matching on it is impossible.
        // Support an EXACT email match via the blind index, plus the usual
        // case-insensitive substring search on display name.
        const emailIdx = emailBlindIndex(input.search);
        where.OR = [
          { displayName: { contains: input.search, mode: "insensitive" } },
          ...(emailIdx ? [{ emailIndex: emailIdx }] : []),
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
        // No email select — the audit subject already identifies the target by
        // name, and the target's email (PII) must never enter the audit log.
        select: { isAdmin: true },
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
        // The subject (target user) resolves to a display name in the viewer;
        // we deliberately do NOT store the target's email (PII) here.
        subjectId: input.userId,
      });

      return { ok: true, unchanged: false };
    }),

  /**
   * Permanently delete a user (admin-only). High blast radius, but the schema's
   * FK rules make it safe + non-blocking: Account / Session / Credential / MFA /
   * Character (→ all snapshots) / GuildMembership / EventSignup / AddonUpload /
   * recruitment rows CASCADE away; owned raid teams + dashboards become
   * leaderless / ownerless and claimed guilds revert to UNCLAIMED (SetNull);
   * AuditLog rows the user authored de-identify (actorUserId SetNull). No
   * Restrict FK exists, so the delete never throws.
   *
   * Only guard: an admin can't delete the account they're SIGNED IN with — that
   * guarantees ≥1 admin always remains, and self-deletion belongs on the
   * profile page (behind a password). Deleting ANY other user — including
   * another admin — is allowed.
   */
  deleteUser: protectedProcedure
    .input(z.object({ userId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertAdmin(ctx.session.user.id);

      if (input.userId === ctx.session.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "You can't delete your own account here — use “Delete account” on your profile.",
        });
      }

      const target = await ctx.db.user.findUnique({
        where: { id: input.userId },
        select: { id: true, displayName: true, isAdmin: true },
      });
      if (!target) throw new TRPCError({ code: "NOT_FOUND" });

      // Audit BEFORE the delete so the actor (admin) + subject still resolve.
      await audit({
        event: "USER_DELETED",
        actorUserId: ctx.session.user.id,
        subjectType: "user",
        subjectId: input.userId,
        metadata: { deletedBy: "admin", wasAdmin: target.isAdmin },
      });

      await ctx.db.user.delete({ where: { id: input.userId } });

      return { ok: true };
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
      const rows = await ctx.db.auditLog.findMany({
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
        },
      });

      // Resolve every opaque id to a human-readable, NON-PII label so an admin
      // can trace an action to a real account / guild / character. We never
      // surface email (PII) or a raw cuid; an id that no longer resolves (a
      // deleted row) renders as "(unknown …)". Metadata id-fields are resolved
      // by their KEY at the TOP level only — nested Discord snowflakes and
      // external WCL ids are deliberately left alone. (See the audit() call-site
      // inventory: actorUserId + subjectType→entity + the id-bearing meta keys.)
      const USER_META_KEYS = [
        "newLeaderUserId",
        "departingUserId",
        "previousOwnerUserId",
        "newOwnerUserId",
        "grantedTo",
      ] as const;
      const CHAR_META_KEYS = ["characterId", "pendingLeaderCharacterId"] as const;
      // Defense-in-depth: scrub emails (PII) from the displayed metadata blob.
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      const asMeta = (m: unknown): Record<string, unknown> | null =>
        m && typeof m === "object" && !Array.isArray(m)
          ? (m as Record<string, unknown>)
          : null;

      const userIds = new Set<string>();
      const guildIds = new Set<string>();
      const charIds = new Set<string>();
      const teamIds = new Set<string>();
      const dashIds = new Set<string>();
      const formIds = new Set<string>();
      const eventIds = new Set<string>();
      const seriesIds = new Set<string>();

      for (const r of rows) {
        if (r.actorUserId) userIds.add(r.actorUserId);
        if (r.subjectId && r.subjectType) {
          switch (r.subjectType) {
            case "user":
              userIds.add(r.subjectId);
              break;
            case "guild":
              guildIds.add(r.subjectId);
              break;
            case "character":
              charIds.add(r.subjectId);
              break;
            case "raidTeam":
              // One audit event (departure cascade) stores a comma-joined list.
              for (const id of r.subjectId.split(",")) teamIds.add(id.trim());
              break;
            case "dashboard":
              dashIds.add(r.subjectId);
              break;
            case "recruitmentForm":
              formIds.add(r.subjectId);
              break;
            case "raidEvent":
              eventIds.add(r.subjectId);
              break;
            case "raidEventSeries":
              seriesIds.add(r.subjectId);
              break;
          }
        }
        const m = asMeta(r.metadata);
        if (m) {
          if (typeof m.guildId === "string") guildIds.add(m.guildId);
          if (typeof m.raidTeamId === "string") teamIds.add(m.raidTeamId);
          if (Array.isArray(m.raidTeamsRemoved))
            for (const x of m.raidTeamsRemoved)
              if (typeof x === "string") teamIds.add(x);
          for (const k of CHAR_META_KEYS)
            if (typeof m[k] === "string") charIds.add(m[k] as string);
          for (const k of USER_META_KEYS)
            if (typeof m[k] === "string") userIds.add(m[k] as string);
        }
      }

      const pick = <T>(s: Set<string>, fn: () => Promise<T[]>): Promise<T[]> =>
        s.size ? fn() : Promise.resolve([]);
      const [users, guilds, chars, teams, dashes, forms, events, series] =
        await Promise.all([
          pick(userIds, () =>
            ctx.db.user.findMany({
              where: { id: { in: [...userIds] } },
              select: { id: true, displayName: true },
            }),
          ),
          pick(guildIds, () =>
            ctx.db.guild.findMany({
              where: { id: { in: [...guildIds] } },
              select: { id: true, name: true, realmSlug: true },
            }),
          ),
          pick(charIds, () =>
            ctx.db.character.findMany({
              where: { id: { in: [...charIds] } },
              select: { id: true, name: true, realmSlug: true },
            }),
          ),
          pick(teamIds, () =>
            ctx.db.raidTeam.findMany({
              where: { id: { in: [...teamIds] } },
              select: { id: true, name: true },
            }),
          ),
          pick(dashIds, () =>
            ctx.db.dashboardConfig.findMany({
              where: { id: { in: [...dashIds] } },
              select: { id: true, name: true },
            }),
          ),
          pick(formIds, () =>
            ctx.db.recruitmentForm.findMany({
              where: { id: { in: [...formIds] } },
              select: { id: true, name: true },
            }),
          ),
          pick(eventIds, () =>
            ctx.db.raidEvent.findMany({
              where: { id: { in: [...eventIds] } },
              select: { id: true, title: true },
            }),
          ),
          pick(seriesIds, () =>
            ctx.db.raidEventSeries.findMany({
              where: { id: { in: [...seriesIds] } },
              select: { id: true, title: true },
            }),
          ),
        ]);

      // displayName is the account name (NOT email — email is PII). A user with
      // no display name shows "Unnamed user", never an id.
      const userLabel = new Map(
        users.map((u) => [u.id, u.displayName ?? "Unnamed user"]),
      );
      const guildLabel = new Map(
        guilds.map((g) => [g.id, `${g.name} (${g.realmSlug})`]),
      );
      const charLabel = new Map(
        chars.map((c) => [c.id, `${c.name}-${c.realmSlug}`]),
      );
      const teamLabel = new Map(teams.map((t) => [t.id, t.name]));
      const dashLabel = new Map(dashes.map((d) => [d.id, d.name]));
      const formLabel = new Map(forms.map((f) => [f.id, f.name]));
      const eventLabel = new Map(events.map((e) => [e.id, e.title]));
      const seriesLabel = new Map(series.map((s) => [s.id, s.title]));

      const resolveMeta = (m: unknown): Record<string, unknown> | null => {
        const o = asMeta(m);
        if (!o) return null;
        const out: Record<string, unknown> = { ...o };
        if (typeof out.guildId === "string")
          out.guildId = guildLabel.get(out.guildId) ?? "(unknown guild)";
        if (typeof out.raidTeamId === "string")
          out.raidTeamId = teamLabel.get(out.raidTeamId) ?? "(unknown team)";
        if (Array.isArray(out.raidTeamsRemoved))
          out.raidTeamsRemoved = out.raidTeamsRemoved.map((x) =>
            typeof x === "string" ? (teamLabel.get(x) ?? "(unknown team)") : x,
          );
        for (const k of CHAR_META_KEYS)
          if (typeof out[k] === "string")
            out[k] = charLabel.get(out[k] as string) ?? "(unknown character)";
        for (const k of USER_META_KEYS)
          if (typeof out[k] === "string")
            out[k] = userLabel.get(out[k] as string) ?? "(unknown user)";
        // Never surface an email (PII) — covers older rows + any future caller
        // that puts an email-valued field in metadata.
        for (const k of Object.keys(out))
          if (
            typeof out[k] === "string" &&
            EMAIL_RE.test((out[k] as string).trim())
          )
            out[k] = "(redacted email)";
        return out;
      };

      const subjectName = (
        type: string | null,
        id: string | null,
      ): string | null => {
        if (!type || !id) return null;
        switch (type) {
          case "user":
            return userLabel.get(id) ?? "(unknown user)";
          case "guild":
            return guildLabel.get(id) ?? "(unknown guild)";
          case "character":
            return charLabel.get(id) ?? "(unknown character)";
          case "raidTeam":
            return id
              .split(",")
              .map((x) => teamLabel.get(x.trim()) ?? "(unknown team)")
              .join(", ");
          case "dashboard":
            return dashLabel.get(id) ?? "(unknown dashboard)";
          case "recruitmentForm":
            return formLabel.get(id) ?? "(unknown form)";
          case "raidEvent":
            return eventLabel.get(id) ?? "(unknown event)";
          case "raidEventSeries":
            return seriesLabel.get(id) ?? "(unknown series)";
          default:
            // Non-entity subjects ("settings"=singleton, "policy"=<name>) are
            // human-readable already — not opaque ids.
            return id;
        }
      };

      return rows.map((r) => ({
        id: r.id,
        event: r.event,
        createdAt: r.createdAt,
        actor: r.actorUserId
          ? (userLabel.get(r.actorUserId) ?? "(unknown user)")
          : "System",
        subjectType: r.subjectType,
        subject: subjectName(r.subjectType, r.subjectId),
        metadata: resolveMeta(r.metadata),
      }));
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
