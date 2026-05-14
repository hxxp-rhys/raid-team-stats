import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { router, protectedProcedure } from "@/server/api/trpc";
import { audit } from "@/server/security/audit";
import {
  startEnrollment,
  confirmEnrollment,
  disable,
} from "@/server/auth/mfa";
import { verifyPassword } from "@/server/crypto/kdf";

/**
 * Per-user TOTP MFA. Enrollment is two-step (start → confirm) so we never
 * mark a user as MFA-enabled until they prove they have a working
 * authenticator. Disable always requires a fresh TOTP / recovery code to
 * defeat session-hijack-led downgrades.
 */
export const mfaRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
      select: { mfaEnabled: true },
    });
    return { enabled: !!user?.mfaEnabled };
  }),

  startEnrollment: protectedProcedure.mutation(async ({ ctx }) => {
    const me = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
      select: { email: true },
    });
    if (!me) throw new TRPCError({ code: "UNAUTHORIZED" });
    const label = `${me.email}`;
    const { secretBase32, otpauthUrl } = await startEnrollment(
      ctx.session.user.id,
      label,
    );
    return { secretBase32, otpauthUrl };
  }),

  confirmEnrollment: protectedProcedure
    .input(z.object({ code: z.string().trim().length(6, "Enter the 6-digit code.") }))
    .mutation(async ({ ctx, input }) => {
      try {
        const { recoveryCodes } = await confirmEnrollment(
          ctx.session.user.id,
          input.code,
        );
        await audit({
          event: "AUTH_MFA_ENABLED",
          actorUserId: ctx.session.user.id,
        });
        return { ok: true as const, recoveryCodes };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to confirm enrollment.";
        throw new TRPCError({ code: "BAD_REQUEST", message });
      }
    }),

  /**
   * Disable MFA. Requires either a current TOTP code OR a recovery code,
   * AND the account password — two factors to undo the second factor.
   */
  disable: protectedProcedure
    .input(
      z.object({
        password: z.string().min(1),
        codeOrRecovery: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const credential = await ctx.db.credential.findUnique({
        where: { userId: ctx.session.user.id },
        select: { passwordHash: true },
      });
      if (!credential) throw new TRPCError({ code: "FORBIDDEN" });

      const passwordOk = await verifyPassword(
        credential.passwordHash,
        input.password,
      );
      if (!passwordOk) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Password is incorrect.",
        });
      }

      try {
        await disable(ctx.session.user.id, input.codeOrRecovery);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to disable MFA.";
        throw new TRPCError({ code: "BAD_REQUEST", message });
      }

      await audit({
        event: "AUTH_MFA_DISABLED",
        actorUserId: ctx.session.user.id,
      });
      return { ok: true };
    }),
});
