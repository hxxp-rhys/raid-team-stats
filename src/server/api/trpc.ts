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
