import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { router, protectedProcedure, assertRaidTeamRole } from "@/server/api/trpc";
import { isDiscordEnabled } from "@/lib/discord/config";
import { issueLinkCode } from "@/server/discord/link";
import { registerGuildCommands } from "@/server/discord/commands";
import { serverActionKey } from "@/server/calendar/sync";
import { audit } from "@/server/security/audit";

const snowflake = z.string().regex(/^\d{15,22}$/, "That doesn't look like a Discord ID.");

export const discordRouter = router({
  /** Is the bot configured on this deployment at all (gates the UI)? */
  status: protectedProcedure.query(() => ({ enabled: isDiscordEnabled() })),

  /** Whether the caller's account is linked to a Discord identity. */
  myLink: protectedProcedure.query(async ({ ctx }) => {
    const acct = await ctx.db.account.findFirst({
      where: { userId: ctx.session.user.id, provider: "discord" },
      select: { providerAccountId: true },
    });
    return { linked: !!acct };
  }),

  /** Issue a fresh 10-minute link code to show on the account page. */
  createLinkCode: protectedProcedure.mutation(async ({ ctx }) => {
    if (!isDiscordEnabled()) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Discord isn't enabled on this server." });
    }
    const { code, expiresAt } = await issueLinkCode(ctx.db, ctx.session.user.id);
    return { code, expiresAt };
  }),

  unlink: protectedProcedure.mutation(async ({ ctx }) => {
    const del = await ctx.db.account.deleteMany({
      where: { userId: ctx.session.user.id, provider: "discord" },
    });
    if (del.count > 0) {
      await audit({
        event: "AUTH_DISCORD_UNLINKED",
        actorUserId: ctx.session.user.id,
        subjectType: "user",
        subjectId: ctx.session.user.id,
        metadata: {},
      });
    }
    return { ok: true };
  }),

  /** Current per-team channel binding (for the settings UI). MEMBER. */
  getIntegration: protectedProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "MEMBER");
      const integration = await ctx.db.discordIntegration.findUnique({
        where: { raidTeamId: input.raidTeamId },
        select: { guildId: true, channelId: true },
      });
      return { enabled: isDiscordEnabled(), integration };
    }),

  /** Bind a team to a Discord guild + channel and register its commands. LEADER. */
  setIntegration: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        guildId: snowflake,
        channelId: snowflake,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!isDiscordEnabled()) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Discord isn't enabled on this server." });
      }
      await assertRaidTeamRole(ctx, input.raidTeamId, "LEADER");
      const before = await ctx.db.discordIntegration.findUnique({
        where: { raidTeamId: input.raidTeamId },
        select: { channelId: true },
      });
      const channelChanged = before?.channelId !== input.channelId;
      await ctx.db.discordIntegration.upsert({
        where: { raidTeamId: input.raidTeamId },
        create: {
          raidTeamId: input.raidTeamId,
          guildId: input.guildId,
          channelId: input.channelId,
          installedByUserId: ctx.session.user.id,
        },
        update: { guildId: input.guildId, channelId: input.channelId },
      });
      // ALWAYS reset the relay cursor to the current outbox tip on bind. This
      // both prevents backfilling past/history events on first bind AND avoids a
      // re-flood of everything produced while disconnected on a reconnect.
      const tip = await ctx.db.syncOutbox.findFirst({
        where: { raidTeamId: input.raidTeamId },
        orderBy: { id: "desc" },
        select: { id: true },
      });
      const tipId = tip?.id ?? BigInt(0);
      await ctx.db.deliveryCursor.upsert({
        where: { consumer_raidTeamId: { consumer: "discord", raidTeamId: input.raidTeamId } },
        create: { consumer: "discord", raidTeamId: input.raidTeamId, lastOutboxId: tipId },
        update: { lastOutboxId: tipId },
      });
      // On a first bind or a channel CHANGE, nudge every FUTURE event so the
      // relay (re)posts it into the now-current channel — these rows land past
      // the just-reset cursor, so only future events flow, never past ones.
      if (channelChanged) {
        const future = await ctx.db.raidEvent.findMany({
          where: { raidTeamId: input.raidTeamId, startsAt: { gte: new Date() } },
          select: { id: true, version: true },
        });
        if (future.length > 0) {
          await ctx.db.syncOutbox.createMany({
            data: future.map((e) => ({
              raidTeamId: input.raidTeamId,
              raidEventId: e.id,
              kind: "event.updated",
              payload: { eventId: e.id, rebind: true },
              version: e.version,
              idempotencyKey: serverActionKey(),
            })),
          });
        }
      }
      await audit({
        event: "RAID_TEAM_SETTINGS_UPDATED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidTeam",
        subjectId: input.raidTeamId,
        metadata: { discord: { guildId: input.guildId, channelId: input.channelId } },
      });
      // Register the guild's slash commands (instant). Best-effort — surfaced to
      // the UI so the leader knows if the bot lacks access.
      const reg = await registerGuildCommands(input.guildId);
      return { ok: true, commandsRegistered: reg.ok, commandError: reg.error ?? null };
    }),

  removeIntegration: protectedProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "LEADER");
      await ctx.db.discordIntegration.deleteMany({ where: { raidTeamId: input.raidTeamId } });
      // Drop the relay cursor too, so a later reconnect starts clean at the tip
      // (a stale cursor would otherwise re-flood the disconnect window).
      await ctx.db.deliveryCursor.deleteMany({
        where: { consumer: "discord", raidTeamId: input.raidTeamId },
      });
      return { ok: true };
    }),
});
