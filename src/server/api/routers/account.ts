import { randomBytes } from "node:crypto";

import { router, protectedProcedure } from "@/server/api/trpc";

/**
 * Account-level settings for the in-game addon + companion uploader:
 * the per-user upload token and recent upload status.
 */

const newToken = (): string =>
  randomBytes(32).toString("base64url"); // ~43 url-safe chars

export const accountRouter = router({
  /**
   * Current upload token (the user's own — safe to show them; they need it
   * to configure the companion) plus the most recent addon uploads.
   */
  uploadStatus: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
      select: { uploadToken: true },
    });
    const uploads = await ctx.db.addonUpload.findMany({
      where: { userId: ctx.session.user.id },
      orderBy: { receivedAt: "desc" },
      take: 20,
      select: {
        collectedAt: true,
        receivedAt: true,
        worldUnlocked: true,
        worldTotal: true,
        weeklyMplusRuns: true,
        addonVersion: true,
        character: { select: { name: true, realmSlug: true } },
      },
    });
    return { token: user?.uploadToken ?? null, uploads };
  }),

  /**
   * Generate (or rotate) the upload token. Rotating invalidates the old
   * one immediately — the companion must be reconfigured with the new value.
   */
  regenerateToken: protectedProcedure.mutation(async ({ ctx }) => {
    const token = newToken();
    await ctx.db.user.update({
      where: { id: ctx.session.user.id },
      data: { uploadToken: token },
    });
    return { token };
  }),

  /** Revoke the token (disables uploads until a new one is generated). */
  revokeToken: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.user.update({
      where: { id: ctx.session.user.id },
      data: { uploadToken: null },
    });
    return { ok: true };
  }),
});
