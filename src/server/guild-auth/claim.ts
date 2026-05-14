import { TRPCError } from "@trpc/server";
import {
  GuildClaimStatus,
  GuildMemberRole,
  GuildMembershipStatus,
} from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { audit } from "@/server/security/audit";

/**
 * Guild-claim policy:
 *
 * - GM auto-claim: a user whose verified character has rosterRank 0 in the
 *   guild's Blizzard roster may claim the guild. They become OWNER.
 * - Admin claim: a platform admin (env: ADMIN_USER_IDS) may grant ownership
 *   to a specific user — used as a fallback when no GM has registered.
 *
 * Race resolution: the Guild.claimStatus column carries the source of truth.
 * `claimByGm` does an atomic UPDATE ... WHERE claimStatus = 'UNCLAIMED', so a
 * concurrent second attempt sees the row as already claimed and the
 * conditional update affects 0 rows. We surface that as a no-op.
 */

type ClaimResult =
  | {
      claimed: true;
      guildId: string;
      newOwnerUserId: string;
      method: "gm" | "admin";
    }
  | { claimed: false; reason: "already_claimed" | "not_gm" };

type GmClaimInput = {
  guildId: string;
  userId: string;
  rosterRank: number | null | undefined;
};

export async function claimByGm({
  guildId,
  userId,
  rosterRank,
}: GmClaimInput): Promise<ClaimResult> {
  if (rosterRank !== 0) {
    return { claimed: false, reason: "not_gm" };
  }

  return db.$transaction(async (tx) => {
    // Conditional update: only fires when status is still UNCLAIMED. updateMany
    // returns { count }, which lets us detect the race without raising.
    const updated = await tx.guild.updateMany({
      where: { id: guildId, claimStatus: GuildClaimStatus.UNCLAIMED },
      data: {
        claimStatus: GuildClaimStatus.GM_CLAIMED,
        claimedByUserId: userId,
        claimedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      return { claimed: false, reason: "already_claimed" };
    }

    await tx.guildMembership.upsert({
      where: { userId_guildId: { userId, guildId } },
      update: {
        role: GuildMemberRole.OWNER,
        status: GuildMembershipStatus.ACTIVE,
        approvedAt: new Date(),
        approvedByUserId: userId,
        departedAt: null,
      },
      create: {
        userId,
        guildId,
        role: GuildMemberRole.OWNER,
        status: GuildMembershipStatus.ACTIVE,
        approvedAt: new Date(),
        approvedByUserId: userId,
      },
    });

    await audit({
      event: "GUILD_CLAIMED",
      actorUserId: userId,
      subjectType: "guild",
      subjectId: guildId,
      metadata: { method: "gm" },
    });

    return { claimed: true, guildId, newOwnerUserId: userId, method: "gm" };
  });
}

type AdminClaimInput = {
  guildId: string;
  newOwnerUserId: string;
  adminUserId: string;
};

/**
 * Admin fallback: a platform admin elevates a specific user to OWNER of a
 * guild that has not yet been GM-claimed. Use sparingly (audited).
 */
export async function claimByAdmin({
  guildId,
  newOwnerUserId,
  adminUserId,
}: AdminClaimInput): Promise<ClaimResult> {
  return db.$transaction(async (tx) => {
    const guild = await tx.guild.findUnique({
      where: { id: guildId },
      select: { claimStatus: true },
    });
    if (!guild) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Guild not found." });
    }
    if (guild.claimStatus !== GuildClaimStatus.UNCLAIMED) {
      return { claimed: false, reason: "already_claimed" };
    }

    await tx.guild.update({
      where: { id: guildId },
      data: {
        claimStatus: GuildClaimStatus.ADMIN_CLAIMED,
        claimedByUserId: newOwnerUserId,
        claimedAt: new Date(),
      },
    });

    await tx.guildMembership.upsert({
      where: { userId_guildId: { userId: newOwnerUserId, guildId } },
      update: {
        role: GuildMemberRole.OWNER,
        status: GuildMembershipStatus.ACTIVE,
        approvedAt: new Date(),
        approvedByUserId: adminUserId,
        departedAt: null,
      },
      create: {
        userId: newOwnerUserId,
        guildId,
        role: GuildMemberRole.OWNER,
        status: GuildMembershipStatus.ACTIVE,
        approvedAt: new Date(),
        approvedByUserId: adminUserId,
      },
    });

    await audit({
      event: "GUILD_CLAIMED",
      actorUserId: adminUserId,
      subjectType: "guild",
      subjectId: guildId,
      metadata: { method: "admin", grantedTo: newOwnerUserId },
    });

    return {
      claimed: true,
      guildId,
      newOwnerUserId,
      method: "admin",
    };
  });
}
