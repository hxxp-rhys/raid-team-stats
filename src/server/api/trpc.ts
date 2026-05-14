import { initTRPC, TRPCError } from "@trpc/server";
import { ZodError } from "zod";
import superjson from "superjson";
import { headers } from "next/headers";
import type { Session } from "next-auth";

import { auth } from "@/server/auth";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

export type TrpcContext = {
  db: typeof db;
  session: Session | null;
  ip: string | null;
  userAgent: string | null;
  origin: string | null;
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
 */
const sameOriginMiddleware = middleware(async ({ ctx, type, next }) => {
  if (type === "mutation") {
    const allowed = process.env.APP_URL ?? "";
    if (allowed && ctx.origin && ctx.origin !== allowed) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Cross-origin request denied" });
    }
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
 * Verifies the caller has at least `minRole` in the guild and the membership
 * status is ACTIVE. Throws NOT_FOUND on missing/inactive, FORBIDDEN on
 * insufficient role.
 */
export async function assertGuildRole(
  ctx: TrpcContext,
  guildId: string,
  minRole: GuildRole,
): Promise<void> {
  if (!ctx.session?.user?.id) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  const membership = await ctx.db.guildMembership.findUnique({
    where: { userId_guildId: { userId: ctx.session.user.id, guildId } },
    select: { role: true, status: true },
  });
  if (!membership || membership.status !== "ACTIVE") {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  if ((guildRoleRank[membership.role] ?? -1) < guildRoleRank[minRole]!) {
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
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  if (
    (raidTeamRoleRank[teamMembership.role] ?? -1) < raidTeamRoleRank[minRole]!
  ) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return { guildId: team.guildId };
}
