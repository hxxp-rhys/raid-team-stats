import { TRPCError } from "@trpc/server";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { consumeLimit, policies } from "@/server/security/rate-limit";
import { audit } from "@/server/security/audit";
import { queues, QUEUE_NAMES } from "@/server/ingestion/queues";
import { blizzardClient } from "@/server/ingestion/blizzard/client";
import { endpoints } from "@/server/ingestion/blizzard/endpoints";
import {
  guildRosterResponseSchema,
  characterSummaryResponseSchema,
  FACTION_MAP,
  type CharacterSummaryResponse,
} from "@/server/ingestion/blizzard/schemas";
import { normalizeRealmSlug } from "@/lib/realm";
import { applyVerification } from "@/server/guild-auth/verify";
import type {
  Region,
  Faction,
  SnapshotSource,
} from "@/generated/prisma/enums";

/**
 * Tier C — user-triggered, single-guild, Blizzard-only roster refresh. The
 * job pulls the guild's full roster, calls character-summary for each member,
 * and feeds the observations through `applyVerification` to upsert characters
 * and roll guild memberships / lifecycle state forward.
 *
 * Rate-limited per-user (1/10min) and per-guild (1/5min) to keep external API
 * spend predictable and to avoid concurrent triggers from multiple members.
 */

export type ManualRosterRefreshPayload = {
  guildId: string;
  triggeredByUserId: string;
};

export type EnqueueOptions = {
  /**
   * Platform admins bypass both per-user and per-guild rate limits. Set by
   * the tRPC layer after checking env.ADMIN_USER_IDS — never trust client
   * input.
   */
  bypassRateLimit?: boolean;
};

export type EnqueueResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: "rate_limited"; retryAfterMs: number };

export async function enqueueManualRosterRefresh(
  input: ManualRosterRefreshPayload,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  if (!options.bypassRateLimit) {
    // Dual rate-limit: per-user (so one member can't burn the budget) and
    // per-guild (so multiple members can't all kick off at once).
    const userLimit = await consumeLimit(policies.manualSyncPerUser, input.triggeredByUserId);
    const guildLimit = await consumeLimit(policies.manualSyncPerGuild, input.guildId);
    if (!userLimit.allowed || !guildLimit.allowed) {
      const retryAfterMs = Math.max(
        userLimit.allowed ? 0 : userLimit.resetAt - Date.now(),
        guildLimit.allowed ? 0 : guildLimit.resetAt - Date.now(),
      );
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Roster refresh is rate-limited. Try again later.",
        cause: { retryAfterMs },
      });
    }
  }

  const job = await queues.manualRosterRefresh.add(QUEUE_NAMES.manualRosterRefresh, input, {
    jobId: `manual_${input.guildId}_${Date.now()}`,
  });
  if (!job.id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  return { ok: true, jobId: job.id };
}

/**
 * Worker handler. Registered in src/server/ingestion/worker.ts.
 *
 * Steps:
 *   1. Fetch the guild roster (Blizzard `/data/wow/guild/{realm}/{slug}/roster`).
 *   2. For each rostered character: fetch the per-character summary (gives us
 *      level + class + faction).
 *   3. Build VerifiedCharacterObservation rows. Note: this Tier C job has no
 *      access to the user OAuth token, so it can only observe public roster
 *      data. Character ownership (which user controls which character) is
 *      established separately by the verify flow on `/profile`.
 *   4. Feed observations into `applyVerification` keyed by an "owner" user
 *      ID. For Tier C we attribute new characters to the guild OWNER as a
 *      placeholder — the per-user Tier A sync will reassign them when each
 *      user runs Battle.net verification.
 */
export async function handleManualRosterRefresh(
  payload: ManualRosterRefreshPayload,
): Promise<{ characters: number; guildMatches: number; autoClaims: number }> {
  const run = await db.syncRun.create({
    data: {
      tier: "C",
      source: "BLIZZARD" satisfies SnapshotSource,
      guildId: payload.guildId,
    },
  });

  try {
    const guild = await db.guild.findUnique({
      where: { id: payload.guildId },
      select: {
        id: true,
        region: true,
        realmSlug: true,
        guildSlug: true,
        name: true,
        faction: true,
        claimedByUserId: true,
      },
    });
    if (!guild) throw new Error(`guild not found: ${payload.guildId}`);

    // Owner attribution placeholder. New character upserts attach to whichever
    // user is registered as the guild owner; this is overwritten once each
    // user verifies their own Battle.net account.
    const ownerUserId = guild.claimedByUserId ?? payload.triggeredByUserId;

    const client = blizzardClient();
    const rosterPath = endpoints.guildRoster(
      regionToCode(guild.region),
      guild.realmSlug,
      guild.guildSlug,
    );
    const roster = await client.request(rosterPath, {
      region: regionToCode(guild.region),
      schema: guildRosterResponseSchema,
      auth: { kind: "app" },
      minFloor: 0, // interactive path — allowed to hit the reserve.
    });

    const observations = [];
    for (const m of roster.members) {
      const realmSlug = normalizeRealmSlug(m.character.realm.slug);
      if (!realmSlug) continue;

      // Per-character summary is OPTIONAL enrichment (character class /
      // level / faction). Blizzard 404s the profile of any character
      // whose profile it doesn't publish (alts, low-level, long-inactive)
      // — that's normal and common in a large guild. The guild-ROSTER
      // endpoint already proved this character IS in the guild, so a
      // summary miss must NOT drop them (that's what shrank the roster to
      // a fraction). Fall back to the roster entry's own data.
      let summary: CharacterSummaryResponse | null = null;
      try {
        summary = await client.request(
          endpoints.characterSummary(regionToCode(guild.region), realmSlug, m.character.name),
          {
            region: regionToCode(guild.region),
            schema: characterSummaryResponseSchema,
            auth: { kind: "app" },
          },
        );
      } catch (err) {
        logger.warn(
          { err, character: m.character.name, realmSlug },
          "character summary unavailable; using roster-entry data",
        );
      }

      observations.push({
        blizzardCharacterId: m.character.id,
        region: guild.region,
        realmSlug,
        characterName: m.character.name,
        faction: factionFromSummary(summary?.faction?.type, guild.faction),
        level: summary?.level ?? m.character.level ?? null,
        classId:
          summary?.character_class?.id ??
          m.character.playable_class?.id ??
          null,
        race: undefined,
        // Attribute every member to THE GUILD WE ARE SYNCING — its row is
        // the single source of truth. Deriving the guild (esp. faction)
        // per-character from each summary is exactly what forked the guild
        // into a duplicate row and split the roster.
        guild: {
          name: guild.name,
          realmSlug: guild.realmSlug,
          faction: guild.faction,
          rosterRank: m.rank,
        },
      });
    }

    const result = await applyVerification({
      userId: ownerUserId,
      observedAt: new Date(),
      characters: observations,
    });

    await db.syncRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        ok: true,
        metrics: {
          characters: observations.length,
          guildMatches: result.guildMatches,
          autoClaims: result.autoClaims,
        },
      },
    });

    return {
      characters: observations.length,
      guildMatches: result.guildMatches,
      autoClaims: result.autoClaims,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, payload }, "manual roster refresh failed");
    await db.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: false, errorMessage: message },
    });
    await audit({
      event: "SYNC_FAILED",
      subjectType: "guild",
      subjectId: payload.guildId,
      metadata: { tier: "C", error: message },
    });
    throw err;
  }
}

const regionToCode = (r: Region): string => r.toLowerCase();

const factionFromSummary = (
  raw: string | undefined,
  fallback: Faction,
): Faction => {
  if (!raw) return fallback;
  return (FACTION_MAP[raw] ?? fallback) as Faction;
};
