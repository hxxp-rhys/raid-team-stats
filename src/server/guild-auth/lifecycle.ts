import { GuildCharacterLinkStatus, GuildMembershipStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { audit } from "@/server/security/audit";

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
      await ensureGuildMembership(tx, characterId, guildId);
      return;
    }

    const wasReactivation = existing.status === GuildCharacterLinkStatus.DEPARTED;
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
      // User may have left and rejoined; force admin re-approval.
      await reactivateMembershipAsPending(tx, characterId, guildId);
      await audit({
        event: "MEMBER_APPROVED",
        subjectType: "character",
        subjectId: characterId,
        metadata: { guildId, kind: "rejoin_requires_approval" },
      });
    }
  });
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
    const affectedTeams = await db.$transaction(async (tx) => {
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
        }
      }

      return teams.map((t) => t.raidTeamId);
    });

    // Audit outside the transaction — audit failures must never roll back the
    // cascade. AuditLog write logs an error rather than throwing.
    await audit({
      event: "MEMBER_DEPARTED",
      subjectType: "character",
      subjectId: characterId,
      metadata: { guildId, raidTeamsRemoved: affectedTeams },
    });

    for (const raidTeamId of affectedTeams) {
      await audit({
        event: "RAID_TEAM_MEMBER_REMOVED",
        subjectType: "raidTeam",
        subjectId: raidTeamId,
        metadata: { characterId, reason: "guild_departure" },
      });
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
): Promise<void> {
  const character = await tx.character.findUnique({
    where: { id: characterId },
    select: { userId: true },
  });
  if (!character) return;

  const existing = await tx.guildMembership.findUnique({
    where: { userId_guildId: { userId: character.userId, guildId } },
  });

  if (!existing) {
    await tx.guildMembership.create({
      data: {
        userId: character.userId,
        guildId,
        status: GuildMembershipStatus.PENDING,
      },
    });
  } else if (existing.status === GuildMembershipStatus.DEPARTED) {
    await tx.guildMembership.update({
      where: { id: existing.id },
      data: { status: GuildMembershipStatus.PENDING, departedAt: null },
    });
  }
}

async function reactivateMembershipAsPending(
  tx: TxClient,
  characterId: string,
  guildId: string,
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
    data: { status: GuildMembershipStatus.PENDING, departedAt: null },
  });
}
