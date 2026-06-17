import { initTRPC, TRPCError } from "@trpc/server";
import { ZodError } from "zod";
import superjson from "superjson";
import { headers } from "next/headers";
import type { Session } from "next-auth";

import { auth } from "@/server/auth";
import { db } from "@/lib/db";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { auditAuthzDenied } from "@/server/security/audit-authz";

export type TrpcContext = {
  db: typeof db;
  session: Session | null;
  ip: string | null;
  userAgent: string | null;
  origin: string | null;
  /**
   * Signed dashboard share token forwarded by the /share/[token] page via
   * the x-share-token request header. Grants READ-ONLY access to the
   * token's raid team — and only when that dashboard is flagged
   * shareIsPublic — via assertTeamReadAccess. Never consulted by
   * mutations or assertRaidTeamRole.
   */
  shareToken: string | null;
};

/**
 * Builds the per-request context. Pulled from headers via `next/headers`
 * (works inside Server Components and Route Handlers in Next 16).
 */
export const createContext = async (): Promise<TrpcContext> => {
  const h = await headers();
  // The Auth.js v5 `auth()` helper is overloaded; the zero-arg form returns
  // Promise<Session | null> but the inferred return type unions all
  // overloads — cast through `unknown` to pick the right shape for our use.
  const session = (await (auth as unknown as () => Promise<Session | null>)()) ?? null;
  return {
    db,
    session,
    ip:
      h.get("x-real-ip") ??
      h.get("cf-connecting-ip") ??
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      null,
    userAgent: h.get("user-agent"),
    origin: h.get("origin"),
    shareToken: h.get("x-share-token"),
  };
};

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const router = t.router;
export const middleware = t.middleware;

/**
 * Lightweight log middleware. Records only the procedure path and outcome.
 * Inputs/outputs are NOT logged here — those flow through pino at the route
 * layer with redaction applied.
 */
const logMiddleware = middleware(async ({ path, type, next }) => {
  const start = Date.now();
  const result = await next();
  const durationMs = Date.now() - start;
  if (result.ok) {
    logger.debug({ path, type, durationMs }, "trpc ok");
  } else {
    logger.warn({ path, type, durationMs, code: result.error.code }, "trpc error");
  }
  return result;
});

/**
 * Same-origin enforcement on mutations to defend against CSRF when the cookie
 * SameSite=Lax fallback isn't enough. Reads (queries) skip this check so RSCs
 * and direct GETs still work.
 *
 * Allowed origins = APP_URL + TRUSTED_ORIGINS (comma-separated). Use the
 * latter when the app is reachable on multiple URLs (e.g. dev via localhost
 * plus prod hostname via the same instance).
 */
// Lazy-built so SKIP_ENV_VALIDATION=1 (Docker build) doesn't crash on
// undefined env values at module evaluation. See feedback memory note about
// the SMTP/BullMQ/key-source/logger family of bugs.
let cachedAllowedOrigins: Set<string> | null = null;
const allowedOrigins = (): Set<string> => {
  if (!cachedAllowedOrigins) {
    cachedAllowedOrigins = new Set<string>([env.APP_URL, ...env.TRUSTED_ORIGINS]);
  }
  return cachedAllowedOrigins;
};

const sameOriginMiddleware = middleware(async ({ ctx, type, next }) => {
  if (type === "mutation" && ctx.origin && !allowedOrigins().has(ctx.origin)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Cross-origin request denied" });
  }
  return next();
});

/**
 * A public procedure — no authentication required. Use sparingly; most
 * endpoints should be protected.
 */
export const publicProcedure = t.procedure.use(logMiddleware).use(sameOriginMiddleware);

/**
 * Protected procedure — requires an authenticated session. The session is
 * narrowed in ctx so downstream procedures can rely on `ctx.session.user.id`.
 */
export const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.session?.user?.id) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      session: ctx.session as Session & { user: { id: string } },
    },
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Authorization helpers — called from procedure resolvers once the input has
// been validated. Using helpers rather than middleware factories keeps the
// procedure builder generic over input shape.
//
// Both helpers throw with NOT_FOUND when the membership doesn't exist (rather
// than FORBIDDEN), to avoid leaking the existence of guilds / teams to non-
// members.
// ────────────────────────────────────────────────────────────────────────────

const guildRoleRank: Record<string, number> = {
  PENDING: 0,
  MEMBER: 1,
  OFFICER: 2,
  OWNER: 3,
};

const raidTeamRoleRank: Record<string, number> = {
  MEMBER: 0,
  CO_LEADER: 1,
  LEADER: 2,
};

export type GuildRole = "PENDING" | "MEMBER" | "OFFICER" | "OWNER";
export type RaidTeamRole = "MEMBER" | "CO_LEADER" | "LEADER";

/**
 * Platform admin override: a user is admin if EITHER (a) their id is in
 * env.ADMIN_USER_IDS, (b) their email is in env.ADMIN_EMAILS, or (c) the
 * User.isAdmin column is true. Admins are treated as OWNER for every guild
 * and LEADER for every raid team, regardless of actual membership rows.
 *
 * env-only fast path — synchronous. Use when only the id is known and you
 * don't want the DB hit. For the full check (including the DB column), call
 * `isPlatformAdmin` which is async and hits the User row.
 */
export const isEnvAdmin = (userId: string | undefined): boolean =>
  typeof userId === "string" && env.ADMIN_USER_IDS.includes(userId);

/**
 * Full admin check. Returns true if any of the three sources says so. Always
 * loads the user row (one query) to capture email + isAdmin; cheap enough for
 * per-request use.
 */
export async function isPlatformAdmin(
  userId: string | undefined,
): Promise<boolean> {
  if (!userId) return false;

  const u = await db.user.findUnique({
    where: { id: userId },
    select: { email: true, isAdmin: true, mfaEnabled: true },
  });
  const email = u?.email?.toLowerCase();

  // (1) Is this principal a platform admin by any of the three sources?
  const baseAdmin =
    env.ADMIN_USER_IDS.includes(userId) ||
    (!!u && (u.isAdmin || (!!email && env.ADMIN_EMAILS.includes(email))));
  if (!baseAdmin) return false;

  // (2) L3: admin privileges require MFA. A configured exemption list
  // (emails and/or user ids) is honoured "for the time being" so the
  // rule never locks out the current admin(s). No MFA + not exempt =>
  // treated as a normal user (admin powers withheld, account otherwise
  // unaffected).
  if (u?.mfaEnabled) return true;
  const exempt = env.ADMIN_MFA_EXEMPT;
  if (exempt.includes(userId.toLowerCase())) return true;
  if (email && exempt.includes(email)) return true;
  return false;
}

/**
 * Verifies the caller has at least `minRole` in the guild and the membership
 * status is ACTIVE. Throws NOT_FOUND on missing/inactive, FORBIDDEN on
 * insufficient role. Platform admins bypass both checks.
 */
export async function assertGuildRole(
  ctx: TrpcContext,
  guildId: string,
  minRole: GuildRole,
): Promise<void> {
  if (!ctx.session?.user?.id) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  if (await isPlatformAdmin(ctx.session.user.id)) return;
  const membership = await ctx.db.guildMembership.findUnique({
    where: { userId_guildId: { userId: ctx.session.user.id, guildId } },
    select: { role: true, status: true },
  });
  if (!membership || membership.status !== "ACTIVE") {
    await auditAuthzDenied({
      actorUserId: ctx.session.user.id,
      scope: "guild",
      subjectId: guildId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { scope: "guild", reason: "not_active_member", minRole },
    });
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  if ((guildRoleRank[membership.role] ?? -1) < guildRoleRank[minRole]!) {
    await auditAuthzDenied({
      actorUserId: ctx.session.user.id,
      scope: "guild",
      subjectId: guildId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        scope: "guild",
        reason: "insufficient_role",
        role: membership.role,
        minRole,
      },
    });
    throw new TRPCError({ code: "FORBIDDEN" });
  }
}

/**
 * Verifies the caller can act on the raid team at the given role. A guild
 * OWNER/OFFICER overrides any raid-team-level role requirement (oversight
 * authority). Throws NOT_FOUND for non-members.
 */
export async function assertRaidTeamRole(
  ctx: TrpcContext,
  raidTeamId: string,
  minRole: RaidTeamRole,
): Promise<{ guildId: string }> {
  if (!ctx.session?.user?.id) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  const team = await ctx.db.raidTeam.findUnique({
    where: { id: raidTeamId },
    select: { id: true, guildId: true },
  });
  if (!team) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }

  // Platform admin override.
  if (await isPlatformAdmin(ctx.session.user.id)) {
    return { guildId: team.guildId };
  }

  // Guild OWNER/OFFICER override.
  const guildMembership = await ctx.db.guildMembership.findUnique({
    where: {
      userId_guildId: { userId: ctx.session.user.id, guildId: team.guildId },
    },
    select: { role: true, status: true },
  });
  if (
    guildMembership?.status === "ACTIVE" &&
    (guildMembership.role === "OWNER" || guildMembership.role === "OFFICER")
  ) {
    return { guildId: team.guildId };
  }

  // Otherwise require team-level membership at >= minRole.
  const teamMembership = await ctx.db.raidTeamMembership.findFirst({
    where: {
      raidTeamId,
      isActive: true,
      character: { userId: ctx.session.user.id },
    },
    select: { role: true },
  });
  if (!teamMembership) {
    await auditAuthzDenied({
      actorUserId: ctx.session.user.id,
      scope: "raidTeam",
      subjectId: raidTeamId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { scope: "raidTeam", reason: "not_member", minRole },
    });
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  if (
    (raidTeamRoleRank[teamMembership.role] ?? -1) < raidTeamRoleRank[minRole]!
  ) {
    await auditAuthzDenied({
      actorUserId: ctx.session.user.id,
      scope: "raidTeam",
      subjectId: raidTeamId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        scope: "raidTeam",
        reason: "insufficient_role",
        role: teamMembership.role,
        minRole,
      },
    });
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return { guildId: team.guildId };
}

/**
 * READ access to a raid team's data — and nothing more. Two grants:
 *   1. A signed-in caller with MEMBER access (assertRaidTeamRole).
 *   2. An anonymous caller carrying a valid share token (x-share-token
 *      header) whose dashboard (a) belongs to THIS team and (b) is flagged
 *      shareIsPublic by its owners.
 * Used ONLY by read-only widget/data queries. Mutations must keep calling
 * assertRaidTeamRole — the token path here can never write, refresh, or
 * see any team other than the one its dashboard belongs to, and flipping
 * shareIsPublic off re-locks every outstanding link at the next request.
 */
export async function assertTeamReadAccess(
  ctx: TrpcContext,
  raidTeamId: string,
): Promise<{ guildId: string }> {
  if (ctx.session?.user?.id) {
    try {
      return await assertRaidTeamRole(ctx, raidTeamId, "MEMBER");
    } catch (err) {
      // A signed-in user who is NOT a member can still view a PUBLIC
      // share like anyone else — fall through to the token grant. Without
      // this, being logged in would paradoxically grant LESS than
      // incognito on a public dashboard.
      if (!ctx.shareToken) throw err;
    }
  }

  if (ctx.shareToken) {
    const { verifyShareToken } = await import(
      "@/server/security/share-token"
    );
    const verified = verifyShareToken(ctx.shareToken);
    if (verified && verified.raidTeamId === raidTeamId) {
      const dashboard = await ctx.db.dashboardConfig.findUnique({
        where: { id: verified.dashboardId },
        select: { raidTeamId: true, shareIsPublic: true },
      });
      if (dashboard?.raidTeamId === raidTeamId && dashboard.shareIsPublic) {
        const team = await ctx.db.raidTeam.findUnique({
          where: { id: raidTeamId },
          select: { guildId: true },
        });
        if (team) return { guildId: team.guildId };
      }
    }
  }

  throw new TRPCError({ code: "UNAUTHORIZED" });
}
