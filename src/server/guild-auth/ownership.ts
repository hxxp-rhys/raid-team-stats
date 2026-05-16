import { GuildClaimStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { audit } from "@/server/security/audit";

/**
 * Ownership-transfer helpers used by the guild lifecycle machinery.
 *
 * Three asset surfaces have user-bound ownership that can change as guild
 * roster ranks evolve:
 *   - Guild.claimedByUserId           (GM_CLAIMED status)
 *   - RaidTeam.leaderUserId
 *   - DashboardConfig.ownerUserId
 *
 * Per spec (May 2026):
 *   - Raid-team LEADER departs the guild
 *       → raid team + its dashboards transfer to the guild's current OWNER.
 *       → If no on-site OWNER exists, the asset is "pending": leaderUserId /
 *         ownerUserId is cleared and pendingLeaderCharacterId /
 *         pendingOwnerCharacterId is set to the guild's rank-0 character so
 *         the first real user to claim that character (via Battle.net verify)
 *         inherits ownership.
 *   - Guild OWNER departs the guild
 *       → guild claim transfers to the next user on a rank-0 character.
 *       → If no on-site rank-0 character exists, guild is marked UNCLAIMED
 *         (the existing GM auto-claim path picks up new signups).
 *   - Guild OWNER is DEMOTED in Blizzard (still in the guild)
 *       → guild claim transfers; raid-team + dashboard ownership UNCHANGED.
 *
 * Functions here are idempotent — re-running after the transfer completes is
 * a no-op. They acquire their own short transaction; callers do not need to
 * pass a tx client.
 */

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/**
 * Picks the user-on-site to inherit ownership when a leader/owner departs.
 *
 * Strategy:
 *   1. If the guild has a current claimedByUserId, that user is the natural
 *      successor (the guild already nominates them).
 *   2. Otherwise, find the lowest-rosterRank ACTIVE GuildCharacterLink and
 *      use that character's owner.
 *
 * Returns:
 *   - { userId, characterId } when a real on-site user was found.
 *   - { userId: null, characterId } when only a Blizzard character was found
 *     (the asset becomes "pending" against that character).
 *   - null when neither exists (caller decides whether to leave the asset
 *     orphaned or what fallback to apply).
 */
export async function findGuildSuccessor(
  tx: Tx,
  guildId: string,
  excludeUserId?: string,
): Promise<
  | { userId: string; characterId: string }
  | { userId: null; characterId: string }
  | null
> {
  // Prefer the guild's own claim if it's still valid and not the user we're
  // explicitly excluding (which is the case when the OWNER themselves departs
  // — they can't inherit from themselves).
  const guild = await tx.guild.findUnique({
    where: { id: guildId },
    select: { claimedByUserId: true },
  });
  if (
    guild?.claimedByUserId &&
    guild.claimedByUserId !== excludeUserId
  ) {
    // The current OWNER is still a viable successor. Find any character of
    // theirs in this guild so we can use it as a pendingClaim fallback if
    // the user is later deleted.
    const ownerChar = await tx.guildCharacterLink.findFirst({
      where: {
        guildId,
        status: "ACTIVE",
        character: { userId: guild.claimedByUserId },
      },
      select: { characterId: true },
    });
    return {
      userId: guild.claimedByUserId,
      characterId: ownerChar?.characterId ?? "",
    };
  }

  // Fall back to the lowest-rank active character. rosterRank can be null
  // (cron didn't see it yet) — those sort last via Postgres NULLS LAST default.
  const next = await tx.guildCharacterLink.findFirst({
    where: {
      guildId,
      status: "ACTIVE",
      rosterRank: { not: null },
      ...(excludeUserId
        ? { character: { userId: { not: excludeUserId } } }
        : {}),
    },
    orderBy: [{ rosterRank: "asc" }, { lastSeenAt: "desc" }],
    select: { characterId: true, character: { select: { userId: true } } },
  });
  if (!next) return null;

  return {
    userId: next.character.userId,
    characterId: next.characterId,
  };
}

/**
 * After a raid-team LEADER departs the guild: transfer team leadership +
 * dashboard ownership for every team they led in this guild to the guild's
 * successor (see findGuildSuccessor).
 *
 * Called from applyDepartureCascade; safe to invoke even if the departing
 * user led nothing (no-op).
 */
export async function transferRaidTeamOwnershipOnDeparture(input: {
  guildId: string;
  departingUserId: string;
  reason: string;
}): Promise<{ teamsTransferred: number; dashboardsTransferred: number }> {
  const { guildId, departingUserId, reason } = input;
  const result = await db.$transaction(async (tx) => {
    const teams = await tx.raidTeam.findMany({
      where: { guildId, leaderUserId: departingUserId },
      select: { id: true, name: true },
    });
    if (teams.length === 0) {
      return { teamsTransferred: 0, dashboardsTransferred: 0 };
    }

    const successor = await findGuildSuccessor(tx, guildId, departingUserId);
    // newLeaderUserId is the on-site user inheriting leadership; null = no
    // on-site successor yet, so we store a pendingLeaderCharacterId instead.
    const newLeaderUserId = successor?.userId ?? null;
    const newPendingCharId = newLeaderUserId
      ? null
      : successor?.characterId ?? null;

    await tx.raidTeam.updateMany({
      where: { id: { in: teams.map((t) => t.id) } },
      data: {
        leaderUserId: newLeaderUserId,
        pendingLeaderCharacterId: newPendingCharId,
      },
    });

    const dashUpdate = await tx.dashboardConfig.updateMany({
      where: {
        raidTeamId: { in: teams.map((t) => t.id) },
        ownerUserId: departingUserId,
      },
      data: {
        ownerUserId: newLeaderUserId,
        pendingOwnerCharacterId: newPendingCharId,
      },
    });

    return {
      teamsTransferred: teams.length,
      dashboardsTransferred: dashUpdate.count,
      teams,
      newLeaderUserId,
      newPendingCharId,
    };
  });

  if (result.teamsTransferred > 0) {
    await audit({
      event: "RAID_TEAM_LEADERSHIP_TRANSFERRED",
      subjectType: "raidTeam",
      subjectId: result.teams!.map((t) => t.id).join(","),
      metadata: {
        reason,
        departingUserId,
        newLeaderUserId: result.newLeaderUserId,
        pendingLeaderCharacterId: result.newPendingCharId,
        teamsTransferred: result.teamsTransferred,
        dashboardsTransferred: result.dashboardsTransferred,
      },
    });
  }

  return {
    teamsTransferred: result.teamsTransferred,
    dashboardsTransferred: result.dashboardsTransferred,
  };
}

/**
 * Re-evaluate who should own a guild based on current rank-0 character.
 * Called when:
 *   - the current OWNER departs the guild
 *   - the current OWNER's rosterRank changes from 0 to anything else
 *     (demotion in Blizzard)
 *   - a new character reaches rosterRank 0 (promotion)
 *
 * Behaviour:
 *   - Find the rank-0 character (if any).
 *   - If its user matches current claimedByUserId, no change.
 *   - Otherwise, transfer claim — set claimedByUserId, claimStatus=GM_CLAIMED.
 *   - If no rank-0 character exists, set claimStatus=UNCLAIMED + null claim.
 *
 * Does NOT touch raid teams or dashboards. The user spec for "demotion"
 * explicitly preserves those.
 */
export async function reevaluateGuildClaim(guildId: string): Promise<{
  changed: boolean;
  newOwnerUserId: string | null;
}> {
  return db.$transaction(async (tx) => {
    const guild = await tx.guild.findUnique({
      where: { id: guildId },
      select: { id: true, claimedByUserId: true, claimStatus: true },
    });
    if (!guild) return { changed: false, newOwnerUserId: null };

    const rank0 = await tx.guildCharacterLink.findFirst({
      where: { guildId, status: "ACTIVE", rosterRank: 0 },
      orderBy: { lastSeenAt: "desc" },
      select: { character: { select: { userId: true } } },
    });

    const desiredOwnerUserId = rank0?.character.userId ?? null;
    if (desiredOwnerUserId === guild.claimedByUserId) {
      return { changed: false, newOwnerUserId: guild.claimedByUserId };
    }

    await tx.guild.update({
      where: { id: guildId },
      data: {
        claimedByUserId: desiredOwnerUserId,
        claimStatus: desiredOwnerUserId
          ? GuildClaimStatus.GM_CLAIMED
          : GuildClaimStatus.UNCLAIMED,
        claimedAt: desiredOwnerUserId ? new Date() : null,
      },
    });

    await audit({
      event: "GUILD_CLAIMED",
      subjectType: "guild",
      subjectId: guildId,
      metadata: {
        reason: "rank0_change",
        previousOwnerUserId: guild.claimedByUserId,
        newOwnerUserId: desiredOwnerUserId,
      },
    });

    logger.info(
      {
        guildId,
        previous: guild.claimedByUserId,
        next: desiredOwnerUserId,
      },
      "guild claim reevaluated",
    );
    return { changed: true, newOwnerUserId: desiredOwnerUserId };
  });
}

/**
 * When a user verifies a Battle.net character and their characters get
 * re-attributed (Character.userId updated), claim any RaidTeams /
 * DashboardConfigs whose `pendingOwnerCharacterId` matches.
 *
 * Returns counts so the caller can surface them to the user
 * (e.g. "1 raid team inherited from your guild leader on signup").
 */
export async function claimPendingAssetsForUser(
  userId: string,
): Promise<{ teamsClaimed: number; dashboardsClaimed: number }> {
  // All character ids owned by this user. Pending assets matching these
  // characters get their ownership transferred.
  const chars = await db.character.findMany({
    where: { userId },
    select: { id: true },
  });
  if (chars.length === 0) {
    return { teamsClaimed: 0, dashboardsClaimed: 0 };
  }
  const charIds = chars.map((c) => c.id);

  const [teams, dashboards] = await db.$transaction([
    db.raidTeam.updateMany({
      where: {
        pendingLeaderCharacterId: { in: charIds },
        leaderUserId: null,
      },
      data: {
        leaderUserId: userId,
        pendingLeaderCharacterId: null,
      },
    }),
    db.dashboardConfig.updateMany({
      where: {
        pendingOwnerCharacterId: { in: charIds },
        ownerUserId: null,
      },
      data: {
        ownerUserId: userId,
        pendingOwnerCharacterId: null,
      },
    }),
  ]);

  if (teams.count > 0 || dashboards.count > 0) {
    await audit({
      event: "RAID_TEAM_LEADERSHIP_TRANSFERRED",
      actorUserId: userId,
      subjectType: "user",
      subjectId: userId,
      metadata: {
        reason: "pending_claim_resolved",
        teamsClaimed: teams.count,
        dashboardsClaimed: dashboards.count,
      },
    });
  }

  return { teamsClaimed: teams.count, dashboardsClaimed: dashboards.count };
}
