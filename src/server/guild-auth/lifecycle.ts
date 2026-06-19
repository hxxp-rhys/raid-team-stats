import { GuildCharacterLinkStatus, GuildMembershipStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { audit } from "@/server/security/audit";
import {
  reevaluateGuildClaim,
  transferRaidTeamOwnershipOnDeparture,
} from "@/server/guild-auth/ownership";
import { enqueueImmediateCharacterSync } from "@/server/ingestion/jobs/tracked-member-sync";

/**
 * Number of consecutive missed sync observations before a character is marked
 * DEPARTED. Two means a single transient API failure can't kick anyone — only
 * sustained absence does.
 */
export const DEPARTURE_GRACE_PERIOD = 2;

// The transaction-callback parameter type, derived from the actual (extended)
// client so the helpers stay in sync with the encryptAccountTokens extension.
type TxClient = Parameters<Parameters<typeof db.$transaction>[0]>[0];

type Observation = {
  characterId: string;
  guildId: string;
  observedAt: Date;
  rosterRank?: number | null;
  /**
   * OAuth-proven ownership (the user verified these are their characters).
   * When true, the rolled-up GuildMembership is created/reactivated as ACTIVE
   * (no approval step). When false/omitted (public roster ingest), it stays
   * PENDING for an officer to approve. Only meaningful for recordGuildPresence.
   */
  verified?: boolean;
};

/**
 * Records that a character WAS observed in the guild during this sync run.
 * Resets the consecutiveAbsences counter and reactivates a DEPARTED link if
 * the character has rejoined.
 *
 * On rejoin: the GuildMembership flips ACTIVE→PENDING (admin must re-approve)
 * if it was previously DEPARTED. RaidTeamMembership rows are NOT auto-
 * restored — the raid leader must re-add the character intentionally.
 */
export async function recordGuildPresence(observation: Observation): Promise<void> {
  const { characterId, guildId, observedAt, rosterRank } = observation;
  const verified = observation.verified ?? false;
  // Track whether this observation might have moved rank 0 around (someone
  // newly promoted to rank 0, or the current rank-0 character demoted). When
  // true, we re-evaluate the guild's claim after the transaction commits.
  let rankZeroChanged = false;
  // Whether this presence observation also discovered (or rediscovered) the
  // character — drives a single immediate per-character sync after the tx
  // commits, so newly-visible roster entries don't show empty widgets until
  // the next hourly tier-A pass.
  let initialSyncTrigger: "discovery" | "rejoin" | null = null;
  await db.$transaction(async (tx) => {
    const existing = await tx.guildCharacterLink.findUnique({
      where: { characterId_guildId: { characterId, guildId } },
    });

    if (!existing) {
      await tx.guildCharacterLink.create({
        data: {
          characterId,
          guildId,
          rosterRank: rosterRank ?? null,
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
          status: GuildCharacterLinkStatus.ACTIVE,
          consecutiveAbsences: 0,
        },
      });
      await ensureGuildMembership(tx, characterId, guildId, verified);
      if (rosterRank === 0) rankZeroChanged = true;
      initialSyncTrigger = "discovery";
      return;
    }

    const wasReactivation = existing.status === GuildCharacterLinkStatus.DEPARTED;
    const previousRank = existing.rosterRank;
    const newRank = rosterRank ?? existing.rosterRank;
    if (previousRank !== newRank && (previousRank === 0 || newRank === 0)) {
      rankZeroChanged = true;
    }
    await tx.guildCharacterLink.update({
      where: { id: existing.id },
      data: {
        rosterRank: rosterRank ?? existing.rosterRank,
        lastSeenAt: observedAt,
        status: GuildCharacterLinkStatus.ACTIVE,
        consecutiveAbsences: 0,
        ...(wasReactivation
          ? { rejoinedAt: observedAt, departedAt: null }
          : {}),
      },
    });

    if (wasReactivation) {
      // User left and rejoined. With OAuth-proven ownership (verified) they
      // re-activate immediately; an unverified public-roster observation keeps
      // the re-approval gate.
      await reactivateMembership(tx, characterId, guildId, verified);
      await audit({
        event: "MEMBER_APPROVED",
        subjectType: "character",
        subjectId: characterId,
        metadata: {
          guildId,
          kind: verified ? "rejoin_auto_active" : "rejoin_requires_approval",
        },
      });
      initialSyncTrigger = "rejoin";
    }
  });

  // Fresh discovery / rejoin → kick off one immediate per-character sync so
  // the dashboards have real data the moment the user lands. Fire-and-forget
  // because the failure mode (hourly tier-A pass still catches them next
  // hour) is acceptable; awaiting would slow every roster-sync iteration.
  if (initialSyncTrigger) {
    void enqueueImmediateCharacterSync(characterId, initialSyncTrigger);
  }

  // Re-evaluate the guild's OWNER (claimedByUserId) when this observation
  // changed who sits at rosterRank 0. Spec: a demotion-only change touches
  // ONLY guild-level claim; raid teams + dashboards are left alone. The
  // ownership helper does exactly that — it never reaches into RaidTeam.
  if (rankZeroChanged) {
    try {
      await reevaluateGuildClaim(guildId);
    } catch (err) {
      logger.warn(
        { err, guildId, characterId },
        "reevaluateGuildClaim after rank change failed",
      );
    }
  }
}

/**
 * Records that a character was NOT observed in the guild during this sync run.
 * Increments consecutiveAbsences; once it crosses DEPARTURE_GRACE_PERIOD,
 * triggers the full departure cascade.
 */
export async function recordGuildAbsence(observation: Observation): Promise<void> {
  const { characterId, guildId, observedAt } = observation;
  const triggered = await db.$transaction(async (tx) => {
    const link = await tx.guildCharacterLink.findUnique({
      where: { characterId_guildId: { characterId, guildId } },
    });
    if (!link || link.status !== GuildCharacterLinkStatus.ACTIVE) return false;

    const nextCount = link.consecutiveAbsences + 1;
    if (nextCount < DEPARTURE_GRACE_PERIOD) {
      await tx.guildCharacterLink.update({
        where: { id: link.id },
        data: { consecutiveAbsences: nextCount },
      });
      return false;
    }
    return true;
  });

  if (triggered) {
    await applyDepartureCascade({ characterId, guildId, observedAt });
  }
}

/**
 * Soft-deactivates a character's guild link and all raid-team memberships,
 * flipping the user's GuildMembership to DEPARTED if this was their last
 * active character in the guild. Atomic via a single Prisma transaction.
 *
 * Idempotent: re-running after the cascade completes is a no-op.
 */
export async function applyDepartureCascade(observation: Observation): Promise<void> {
  const { characterId, guildId, observedAt } = observation;
  try {
    const result = await db.$transaction(async (tx) => {
      // 1. Mark the character link departed.
      await tx.guildCharacterLink.updateMany({
        where: {
          characterId,
          guildId,
          status: GuildCharacterLinkStatus.ACTIVE,
        },
        data: {
          status: GuildCharacterLinkStatus.DEPARTED,
          departedAt: observedAt,
          lastSeenAt: observedAt,
        },
      });

      // 2. Soft-deactivate every raid-team membership tied to this character
      //    whose team is in the same guild. (Other guilds' teams are not
      //    touched — but in practice a character belongs to one guild at a
      //    time anyway.)
      const teams = await tx.raidTeamMembership.findMany({
        where: {
          characterId,
          isActive: true,
          raidTeam: { guildId },
        },
        select: { id: true, raidTeamId: true },
      });
      if (teams.length > 0) {
        await tx.raidTeamMembership.updateMany({
          where: { id: { in: teams.map((t) => t.id) } },
          data: {
            isActive: false,
            removedAt: observedAt,
            removalReason: "guild_departure",
          },
        });
      }

      // 3. If this was the character owner's last active link to the guild,
      //    flip their GuildMembership to DEPARTED.
      const character = await tx.character.findUnique({
        where: { id: characterId },
        select: { userId: true },
      });
      let userFullyDeparted = false;
      if (character) {
        const remainingActive = await tx.guildCharacterLink.count({
          where: {
            guildId,
            status: GuildCharacterLinkStatus.ACTIVE,
            character: { userId: character.userId },
          },
        });
        if (remainingActive === 0) {
          await tx.guildMembership.updateMany({
            where: {
              guildId,
              userId: character.userId,
              status: { not: GuildMembershipStatus.DEPARTED },
            },
            data: { status: GuildMembershipStatus.DEPARTED, departedAt: observedAt },
          });
          userFullyDeparted = true;
        }
      }

      return {
        affectedTeams: teams.map((t) => t.raidTeamId),
        departingUserId: character?.userId ?? null,
        userFullyDeparted,
      };
    });

    // Audit outside the transaction — audit failures must never roll back the
    // cascade. AuditLog write logs an error rather than throwing.
    await audit({
      event: "MEMBER_DEPARTED",
      subjectType: "character",
      subjectId: characterId,
      metadata: { guildId, raidTeamsRemoved: result.affectedTeams },
    });

    for (const raidTeamId of result.affectedTeams) {
      await audit({
        event: "RAID_TEAM_MEMBER_REMOVED",
        subjectType: "raidTeam",
        subjectId: raidTeamId,
        metadata: { characterId, reason: "guild_departure" },
      });
    }

    // Ownership cascade — only fires when this departure took the user
    // entirely out of the guild (last active character). Two paths:
    //   a) Departing user led one or more raid teams → transfer those teams +
    //      their dashboards to the guild's successor (or pending fallback).
    //   b) Departing user was the guild's claimed OWNER → re-evaluate the
    //      guild claim to the new rank-0 user.
    if (result.userFullyDeparted && result.departingUserId) {
      const departingUserId = result.departingUserId;
      try {
        await transferRaidTeamOwnershipOnDeparture({
          guildId,
          departingUserId,
          reason: "guild_departure",
        });
      } catch (err) {
        logger.error(
          { err, guildId, departingUserId },
          "raid-team ownership transfer failed during departure cascade",
        );
      }
      try {
        const guild = await db.guild.findUnique({
          where: { id: guildId },
          select: { claimedByUserId: true },
        });
        if (guild?.claimedByUserId === departingUserId) {
          await reevaluateGuildClaim(guildId);
        }
      } catch (err) {
        logger.error(
          { err, guildId, departingUserId },
          "guild claim reevaluation failed during departure cascade",
        );
      }
    }
  } catch (err) {
    logger.error({ err, characterId, guildId }, "departure cascade failed");
    throw err;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────────

async function ensureGuildMembership(
  tx: TxClient,
  characterId: string,
  guildId: string,
  verified: boolean,
): Promise<void> {
  const character = await tx.character.findUnique({
    where: { id: characterId },
    select: { userId: true },
  });
  if (!character) return;

  const existing = await tx.guildMembership.findUnique({
    where: { userId_guildId: { userId: character.userId, guildId } },
  });

  // verified === OAuth-proven ownership → the user joins their own guild as an
  // ACTIVE member immediately (no approval gate). Unverified public-roster
  // ingest keeps the PENDING-then-approve flow.
  const targetStatus = verified
    ? GuildMembershipStatus.ACTIVE
    : GuildMembershipStatus.PENDING;

  if (!existing) {
    await tx.guildMembership.create({
      data: {
        userId: character.userId,
        guildId,
        status: targetStatus,
      },
    });
  } else if (existing.status === GuildMembershipStatus.DEPARTED) {
    await tx.guildMembership.update({
      where: { id: existing.id },
      data: { status: targetStatus, departedAt: null },
    });
  } else if (verified && existing.status === GuildMembershipStatus.PENDING) {
    // The owner just proved they own a character in this guild — promote their
    // existing pending membership to ACTIVE.
    await tx.guildMembership.update({
      where: { id: existing.id },
      data: { status: GuildMembershipStatus.ACTIVE },
    });
  }
}

async function reactivateMembership(
  tx: TxClient,
  characterId: string,
  guildId: string,
  verified: boolean,
): Promise<void> {
  const character = await tx.character.findUnique({
    where: { id: characterId },
    select: { userId: true },
  });
  if (!character) return;

  await tx.guildMembership.updateMany({
    where: {
      userId: character.userId,
      guildId,
      status: GuildMembershipStatus.DEPARTED,
    },
    data: {
      status: verified
        ? GuildMembershipStatus.ACTIVE
        : GuildMembershipStatus.PENDING,
      departedAt: null,
    },
  });
}
