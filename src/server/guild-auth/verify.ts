import type { Region, Faction } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { normalizeRealmSlug, normalizeGuildSlug } from "@/lib/realm";
import {
  recordGuildPresence,
  recordGuildAbsence,
} from "@/server/guild-auth/lifecycle";
import { claimByGm } from "@/server/guild-auth/claim";

/**
 * Phase 3 scaffolding: shape of one Blizzard-reported character + guild
 * membership. The Phase 4 Blizzard client returns this exact shape; v1 uses
 * `applyVerification` directly with hand-built fixtures for testing and for
 * the manual Tier C roster refresh.
 */
export type VerifiedCharacterObservation = {
  blizzardCharacterId: bigint;
  region: Region;
  realmSlug: string;
  characterName: string;
  faction: Faction;
  level?: number | null;
  classId?: number | null;
  race?: string | null;
  // Guild presence at observation time. null/undefined => no guild.
  guild?: {
    name: string;
    realmSlug: string;
    faction: Faction;
    rosterRank?: number | null;
  } | null;
};

type ApplyVerificationInput = {
  userId: string;
  observedAt: Date;
  characters: VerifiedCharacterObservation[];
};

type ApplyVerificationResult = {
  upserted: number;
  guildMatches: number;
  autoClaims: number;
};

/**
 * Applies a batch of Blizzard-verified character observations for one user.
 * Upserts the Character rows, matches each to an existing Guild row, and
 * records presence (or absence) so the lifecycle module can roll up to a
 * GuildMembership / RaidTeamMembership cascade.
 *
 * This function is intentionally Blizzard-API-agnostic — the caller (Phase 4
 * Blizzard client + Tier A/B/C workers) is responsible for fetching the data
 * and shaping it into VerifiedCharacterObservation objects. That keeps the
 * verification logic unit-testable without a mocked HTTP client.
 */
export async function applyVerification(
  input: ApplyVerificationInput,
): Promise<ApplyVerificationResult> {
  let upserted = 0;
  let guildMatches = 0;
  let autoClaims = 0;

  for (const obs of input.characters) {
    const realmSlug = normalizeRealmSlug(obs.realmSlug);
    if (!realmSlug) continue;

    // Upsert the character row by stable Blizzard ID.
    const character = await db.character.upsert({
      where: { blizzardCharacterId: obs.blizzardCharacterId },
      create: {
        userId: input.userId,
        blizzardCharacterId: obs.blizzardCharacterId,
        region: obs.region,
        realmSlug,
        name: obs.characterName,
        faction: obs.faction,
        classId: obs.classId ?? null,
        race: obs.race ?? null,
        level: obs.level ?? null,
        lastSyncedAt: input.observedAt,
      },
      update: {
        region: obs.region,
        realmSlug,
        name: obs.characterName,
        faction: obs.faction,
        classId: obs.classId ?? null,
        race: obs.race ?? null,
        level: obs.level ?? null,
        lastSyncedAt: input.observedAt,
      },
    });
    upserted++;

    // Resolve the guild row (if any).
    if (!obs.guild) continue;
    const guildRealmSlug = normalizeRealmSlug(obs.guild.realmSlug);
    const guildSlug = normalizeGuildSlug(obs.guild.name);
    if (!guildRealmSlug || !guildSlug) continue;

    const guild = await db.guild.upsert({
      where: {
        region_realmSlug_guildSlug_faction: {
          region: obs.region,
          realmSlug: guildRealmSlug,
          guildSlug,
          faction: obs.guild.faction,
        },
      },
      create: {
        region: obs.region,
        realmSlug: guildRealmSlug,
        guildSlug,
        name: obs.guild.name,
        faction: obs.guild.faction,
      },
      update: {
        name: obs.guild.name,
      },
    });
    guildMatches++;

    await recordGuildPresence({
      characterId: character.id,
      guildId: guild.id,
      observedAt: input.observedAt,
      rosterRank: obs.guild.rosterRank ?? null,
    });

    // Opportunistic GM auto-claim — only fires when the guild is UNCLAIMED
    // and the character is rosterRank 0.
    if (
      obs.guild.rosterRank === 0 &&
      guild.claimStatus === "UNCLAIMED"
    ) {
      const result = await claimByGm({
        guildId: guild.id,
        userId: input.userId,
        rosterRank: 0,
      });
      if (result.claimed) autoClaims++;
    }
  }

  // Any guild this user previously had links to but the current snapshot did
  // NOT include — increment absence counters. This drives the slow-burn
  // departure detection on Tier B (weekly full-guild sync) and on Tier A
  // when a tracked character changes guilds.
  await markUnobservedAbsences(input);

  return { upserted, guildMatches, autoClaims };
}

async function markUnobservedAbsences(
  input: ApplyVerificationInput,
): Promise<void> {
  // Build a per-character map of which guild each observed character is in.
  // Characters not in this map were not observed at all this run.
  // String-keyed because blizzardCharacterId is BigInt on the Prisma row but
  // number on the observation input — stringify both sides to compare.
  const observedCharGuildKey = new Map<string, string | null>();
  for (const c of input.characters) {
    const key = c.guild
      ? `${c.region}|${normalizeRealmSlug(c.guild.realmSlug)}|${normalizeGuildSlug(c.guild.name)}|${c.guild.faction}`
      : null;
    observedCharGuildKey.set(String(c.blizzardCharacterId), key);
  }

  // Pull every ACTIVE link this user owns — including links to characters
  // that weren't observed this run, which still need absence-counter
  // increments under the lifecycle grace-period rules in CLAUDE.md.
  const links = await db.guildCharacterLink.findMany({
    where: {
      status: "ACTIVE",
      character: { userId: input.userId },
    },
    select: {
      characterId: true,
      guildId: true,
      guild: { select: { region: true, realmSlug: true, guildSlug: true, faction: true } },
      character: { select: { blizzardCharacterId: true } },
    },
  });

  for (const link of links) {
    const linkGuildKey = `${link.guild.region}|${link.guild.realmSlug}|${link.guild.guildSlug}|${link.guild.faction}`;
    const observedKey = observedCharGuildKey.get(String(link.character.blizzardCharacterId));
    // Reaffirmed: this character is still observed in this exact guild.
    if (observedKey === linkGuildKey) continue;
    // Anything else (observed in a different guild, or not observed at all)
    // counts as an absence for this (character, guild) pair.
    await recordGuildAbsence({
      characterId: link.characterId,
      guildId: link.guildId,
      observedAt: input.observedAt,
    });
  }
}
