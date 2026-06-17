import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { router, publicProcedure, protectedProcedure } from "@/server/api/trpc";
import {
  emailSchema,
  passwordSchema,
  registerSchema,
} from "@/server/auth/schemas";
import { hashPassword, verifyPassword } from "@/server/crypto/kdf";
import { emailBlindIndex } from "@/server/auth/email-index";
import {
  issueToken,
  consumeToken,
  buildVerifyUrl,
  buildResetUrl,
} from "@/server/auth/tokens";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from "@/lib/email";
import { consumeLimit, policies } from "@/server/security/rate-limit";
import { audit } from "@/server/security/audit";
import { logger } from "@/lib/logger";

/**
 * Auth-related write endpoints. Sign-in itself is handled by Auth.js at
 * `/api/auth/...`; this router covers registration, email verification, and
 * password reset.
 *
 * Account-enumeration protection: every endpoint returns the same shape on
 * success and on "no such account" failure. The only branch that errors
 * loudly is rate-limiting (so a legitimate user knows to back off).
 */

const tokenInput = z.object({
  token: z.string().min(16, "Token is missing or malformed").max(256),
});

export const authRouter = router({
  register: publicProcedure
    .input(registerSchema)
    .mutation(async ({ ctx, input }) => {
      // Rate-limit key: prefer client IP, else collapse to a single shared
      // bucket so an attacker can't sidestep the per-IP cap by rotating the
      // submitted email.
      const rl = await consumeLimit(policies.authSignupPerIp, ctx.ip ?? "no-ip");
      if (!rl.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many sign-up attempts. Please try again later.",
        });
      }

      const emailIdx = emailBlindIndex(input.email);
      const existing = emailIdx
        ? await ctx.db.user.findUnique({
            where: { emailIndex: emailIdx },
            select: { id: true },
          })
        : null;

      // Account enumeration: same shape whether the email is new or taken.
      // Both branches do a dummy/real argon2id so response timing doesn't
      // distinguish them.
      if (existing) {
        // Equalize timing — argon2id is the slowest step on the happy path.
        await hashPassword(input.password);
        await audit({
          event: "AUTH_LOGIN_FAILURE",
          actorUserId: existing.id,
          metadata: { reason: "duplicate_signup_attempt" },
          ip: ctx.ip ?? undefined,
          userAgent: ctx.userAgent ?? undefined,
        });
        return { ok: true };
      }

      const passwordHash = await hashPassword(input.password);

      const user = await ctx.db.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: {
            email: input.email,
            displayName: input.displayName,
          },
        });
        await tx.credential.create({
          data: { userId: u.id, passwordHash },
        });
        return u;
      });

      const { raw } = await issueToken("verify_email", user.id);
      // input.email is the just-created user's email (non-null zod string);
      // User.email is now nullable in the type, so use the input source.
      await sendVerificationEmail(input.email, buildVerifyUrl(raw));

      await audit({
        event: "USER_CREATED",
        actorUserId: user.id,
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });

      return { ok: true };
    }),

  /**
   * Re-send the verification email for an already-registered, not-yet-verified
   * account. Returns ok regardless of whether the email exists or has already
   * been verified — same shape to prevent enumeration.
   */
  resendVerification: publicProcedure
    .input(z.object({ email: emailSchema }))
    .mutation(async ({ ctx, input }) => {
      const rl = await consumeLimit(policies.authSignupPerIp, ctx.ip ?? "no-ip");
      if (!rl.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many attempts. Please try again later.",
        });
      }
      const emailIdx = emailBlindIndex(input.email);
      const user = emailIdx
        ? await ctx.db.user.findUnique({
            where: { emailIndex: emailIdx },
            select: { id: true, email: true, emailVerified: true },
          })
        : null;
      if (user && !user.emailVerified) {
        const { raw } = await issueToken("verify_email", user.id);
        // Looked up by `email: input.email`, so it equals input.email (a
        // non-null zod string). User.email is nullable in the type now.
        await sendVerificationEmail(input.email, buildVerifyUrl(raw));
        await audit({
          event: "USER_CREATED",
          actorUserId: user.id,
          metadata: { step: "verification_resent" },
          ip: ctx.ip ?? undefined,
          userAgent: ctx.userAgent ?? undefined,
        });
      }
      return { ok: true };
    }),

  verifyEmail: publicProcedure
    .input(tokenInput)
    .mutation(async ({ ctx, input }) => {
      const userId = await consumeToken("verify_email", input.token);
      if (!userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This verification link is invalid or has expired.",
        });
      }

      const updated = await ctx.db.user.update({
        where: { id: userId },
        data: { emailVerified: new Date() },
        select: { id: true, email: true },
      });

      await audit({
        event: "USER_CREATED", // verification effectively activates the account
        actorUserId: updated.id,
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
        metadata: { step: "email_verified" },
      });

      return { ok: true };
    }),

  requestPasswordReset: publicProcedure
    .input(z.object({ email: emailSchema }))
    .mutation(async ({ ctx, input }) => {
      const rl = await consumeLimit(
        policies.authLoginPerEmail,
        input.email,
      );
      // Hard rate-limit returns OK to avoid leaking timing, but skips work.
      if (!rl.allowed) return { ok: true };

      const emailIdx = emailBlindIndex(input.email);
      const user = emailIdx
        ? await ctx.db.user.findUnique({
            where: { emailIndex: emailIdx },
            select: { id: true, email: true },
          })
        : null;

      if (!user) {
        // Account-enumeration defence: respond identically whether the email
        // exists or not. No user-side hint of difference.
        return { ok: true };
      }

      try {
        const { raw } = await issueToken("password_reset", user.id);
        // Looked up by `email: input.email` → equals input.email (non-null).
        await sendPasswordResetEmail(input.email, buildResetUrl(raw));
      } catch (err) {
        // Same response either way; log internally.
        logger.error({ err, userId: user.id }, "password reset issuance failed");
      }

      await audit({
        event: "AUTH_PASSWORD_RESET_REQUEST",
        actorUserId: user.id,
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });

      return { ok: true };
    }),

  confirmPasswordReset: publicProcedure
    .input(
      z.object({
        token: z.string().min(16).max(256),
        password: passwordSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = await consumeToken("password_reset", input.token);
      if (!userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This reset link is invalid or has expired.",
        });
      }

      const passwordHash = await hashPassword(input.password);

      // Prior credential may not exist if this user was OAuth-only — create
      // or update accordingly. Successful reset proves the user controls
      // the email; if they hadn't verified yet, mark them verified now so
      // they're not stuck in an unverified-but-credentialed limbo.
      await ctx.db.$transaction([
        ctx.db.credential.upsert({
          where: { userId },
          update: { passwordHash, lastChangedAt: new Date(), failedLogins: 0 },
          create: { userId, passwordHash },
        }),
        ctx.db.user.updateMany({
          where: { id: userId, emailVerified: null },
          data: { emailVerified: new Date() },
        }),
      ]);

      await audit({
        event: "AUTH_PASSWORD_RESET_COMPLETE",
        actorUserId: userId,
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });

      return { ok: true };
    }),

  /**
   * GDPR right-to-erasure. Requires the caller to confirm with their current
   * password. Cascade-deletes the User row → Prisma onDelete handles auth
   * tables, characters, snapshots, guild memberships, raid-team memberships,
   * dashboards, and (via SetNull) the historical audit log. Raid-team
   * leadership has onDelete: Restrict — the user must transfer those teams
   * first, which we surface as a clean error.
   */
  deleteAccount: protectedProcedure
    .input(z.object({ password: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const credential = await ctx.db.credential.findUnique({
        where: { userId: ctx.session.user.id },
        select: { passwordHash: true },
      });
      if (!credential) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This account has no password set. Reset your password first, then retry.",
        });
      }
      const ok = await verifyPassword(credential.passwordHash, input.password);
      if (!ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Password is incorrect.",
        });
      }

      const blockingTeams = await ctx.db.raidTeam.findMany({
        where: { leaderUserId: ctx.session.user.id },
        select: { id: true, name: true },
      });
      if (blockingTeams.length > 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            `You're still the leader of ${blockingTeams.length} raid team(s): ` +
            blockingTeams.map((t) => t.name).join(", ") +
            `. Transfer leadership before deleting your account.`,
        });
      }

      const userId = ctx.session.user.id;

      // Audit BEFORE the delete so the actor reference still resolves —
      // the actor relation is SetNull, so post-delete rows just lose the
      // pointer but the event survives.
      await audit({
        event: "USER_DELETED",
        actorUserId: userId,
        subjectType: "user",
        subjectId: userId,
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });

      await ctx.db.user.delete({ where: { id: userId } });
      return { ok: true };
    }),
});

/**
 * Self-check helper for the password change flow (Phase 2.x — surfaced on
 * the profile page). Not exported from the router yet, but kept here so the
 * shape is reviewed alongside the other auth code.
 */
export async function verifyExistingPassword(
  userId: string,
  password: string,
  db: { credential: { findUnique: (a: { where: { userId: string } }) => Promise<{ passwordHash: string } | null> } },
): Promise<boolean> {
  const credential = await db.credential.findUnique({ where: { userId } });
  if (!credential) return false;
  return verifyPassword(credential.passwordHash, password);
}
