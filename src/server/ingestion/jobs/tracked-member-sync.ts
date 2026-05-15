import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { queues, QUEUE_NAMES } from "@/server/ingestion/queues";
import { blizzardClient } from "@/server/ingestion/blizzard/client";
import { endpoints } from "@/server/ingestion/blizzard/endpoints";
import {
  characterSummaryResponseSchema,
  mythicKeystoneIndexResponseSchema,
  mythicKeystoneSeasonResponseSchema,
  raidEncountersResponseSchema,
} from "@/server/ingestion/blizzard/schemas";
import {
  writeCharacterSnapshot,
  writeEquipmentSnapshot,
  writeMplusSnapshot,
  writeRaidSnapshot,
  writeVaultSnapshot,
  logSnapshotError,
} from "@/server/ingestion/snapshots";
import type { Region } from "@/generated/prisma/enums";
import { z } from "zod";

/**
 * Tier A — hourly tracked-member sync. Runs every hour at minute 5 (cron
 * `5 * * * *` America/New_York) and refreshes every Character that's on at
 * least one ACTIVE raid-team membership. Pulls all sources we have wired:
 *   - Blizzard: character summary + equipment
 *   - WCL: zone-rankings for the current raid tier (Phase 4.x)
 *   - Raider.IO: M+ scores + weekly highest runs (Phase 4.x)
 *
 * This turn ships the Blizzard half. WCL + Raider.IO writers slot in as the
 * tracked-member job handler gets fan-out to those sources too.
 */

export type TrackedMemberSyncPayload = {
  characterId: string;
};

export async function enqueueTrackedMemberSyncForAll(): Promise<{ enqueued: number }> {
  // Distinct characters that are on any active raid-team membership.
  const characters = await db.character.findMany({
    where: {
      raidMemberships: { some: { isActive: true } },
    },
    select: { id: true },
  });
  if (characters.length === 0) return { enqueued: 0 };

  await queues.trackedMemberSync.addBulk(
    characters.map((c) => ({
      name: QUEUE_NAMES.trackedMemberSync,
      data: { characterId: c.id } satisfies TrackedMemberSyncPayload,
      opts: { jobId: `tier-a:${c.id}:${hourKey()}` },
    })),
  );
  return { enqueued: characters.length };
}

// Minimal equipment shape we extract from the Blizzard payload. The full
// payload lives in rawPayload for replay.
//
// `set` carries the item-set membership when an equipped piece belongs to a
// raid tier set. Blizzard returns:
//   {
//     "item_set": { "id": 1735, "name": "Foo Tier Set" },
//     "items": [...],
//     "effects": [
//       { "display_string": "(2) Set: ...", "required_count": 2 },
//       { "display_string": "(4) Set: ...", "required_count": 4 }
//     ]
//   }
// We count distinct equipped pieces by item_set.id; the tier-set tracker
// widget renders the resulting 0–5 score per character.
const equipmentItemSchema = z
  .object({
    slot: z.object({ type: z.string() }).passthrough().optional(),
    item: z.object({ id: z.number() }).passthrough().optional(),
    level: z.object({ value: z.number().optional() }).passthrough().optional(),
    enchantments: z.array(z.unknown()).optional(),
    sockets: z.array(z.unknown()).optional(),
    set: z
      .object({
        item_set: z.object({ id: z.number().int() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const equipmentResponseSchema = z
  .object({
    equipped_items: z.array(equipmentItemSchema).default([]),
    equipped_item_level: z.number().optional(),
  })
  .passthrough();

export async function handleTrackedMemberSync(
  payload: TrackedMemberSyncPayload,
): Promise<void> {
  const character = await db.character.findUnique({
    where: { id: payload.characterId },
    select: {
      id: true,
      name: true,
      realmSlug: true,
      region: true,
      level: true,
    },
  });
  if (!character) {
    logger.warn({ payload }, "tier-a: character not found, skipping");
    return;
  }

  const region = regionToCode(character.region);
  const client = blizzardClient();
  const capturedAt = new Date();

  // 1. Character summary (gives current level + class + iLvL).
  try {
    const summary = await client.request(
      endpoints.characterSummary(region, character.realmSlug, character.name),
      {
        region,
        schema: characterSummaryResponseSchema,
        auth: { kind: "app" },
        minFloor: 5, // hourly tier reserves room for interactive paths.
      },
    );

    const itemLevel =
      summary.equipped_item_level ?? summary.average_item_level ?? null;
    // Blizzard returns `active_spec.name` as either a raw string or a
    // locale-keyed object; coerce to the canonical English label when present.
    const specName =
      typeof summary.active_spec?.name === "string"
        ? summary.active_spec.name
        : typeof summary.active_spec?.name === "object"
          ? (summary.active_spec.name.en_US ??
            Object.values(summary.active_spec.name)[0] ??
            null)
          : null;
    const specId =
      typeof summary.active_spec?.id === "number" ? summary.active_spec.id : null;

    await writeCharacterSnapshot({
      characterId: character.id,
      source: "BLIZZARD",
      capturedAt,
      itemLevel,
      level: summary.level ?? null,
      specId,
      specName,
      loadoutText: null,
      rawPayload: summary,
    });

    // Keep Character.lastSyncedAt fresh + sync level if it drifted.
    await db.character.update({
      where: { id: character.id },
      data: {
        lastSyncedAt: capturedAt,
        level: summary.level ?? character.level ?? null,
      },
    });
  } catch (err) {
    logSnapshotError(err, { stage: "summary", characterId: character.id });
  }

  // 2. Equipment.
  try {
    const equipment = await client.request(
      endpoints.characterEquipment(region, character.realmSlug, character.name),
      {
        region,
        schema: equipmentResponseSchema,
        auth: { kind: "app" },
        minFloor: 5,
      },
    );

    // Audit aggregates: missing enchants on slots that conventionally take one
    // (chest, wrist, back, weapon — kept conservative; the dashboard surfaces
    // the per-slot detail).
    const missingEnchantsCount = equipment.equipped_items.filter(
      (i) => !i.enchantments || i.enchantments.length === 0,
    ).length;
    const missingGemsCount = equipment.equipped_items.filter(
      (i) => i.sockets && i.sockets.length === 0,
    ).length;

    // Count distinct tier-set IDs across equipped pieces, then the dominant
    // set's piece count. "Dominant" matters because Blizzard models legacy
    // and current tier with the same set field — players can have 2pc of
    // last season + 2pc of this one — and the tracker should report the
    // highest active stack, not the sum.
    const piecesByItemSet = new Map<number, number>();
    for (const item of equipment.equipped_items) {
      const setId = item.set?.item_set?.id;
      if (typeof setId === "number") {
        piecesByItemSet.set(setId, (piecesByItemSet.get(setId) ?? 0) + 1);
      }
    }
    const tierSetIds = Array.from(piecesByItemSet.keys()).sort();
    const tierSetPiecesCount = piecesByItemSet.size === 0
      ? 0
      : Math.max(...piecesByItemSet.values());

    await writeEquipmentSnapshot({
      characterId: character.id,
      source: "BLIZZARD",
      capturedAt,
      itemLevel: equipment.equipped_item_level ?? null,
      missingEnchantsCount,
      missingGemsCount,
      tierSetPiecesCount,
      tierSetIds,
      items: equipment.equipped_items,
      rawPayload: equipment,
    });
  } catch (err) {
    logSnapshotError(err, { stage: "equipment", characterId: character.id });
  }

  // 3. Raid encounters. Blizzard returns the full per-expansion → per-instance
  //    → per-mode → per-encounter completion list. We persist a compact slice
  //    keyed to the LATEST expansion the character has any progress in;
  //    rawPayload retains the full payload for later replay.
  try {
    const raids = await client.request(
      endpoints.characterRaids(region, character.realmSlug, character.name),
      {
        region,
        schema: raidEncountersResponseSchema,
        auth: { kind: "app" },
        minFloor: 5,
      },
    );

    // Pick the highest-id expansion (== most recent) that has progress.
    const expansionsWithProgress = (raids.expansions ?? []).filter(
      (e) => (e.instances?.length ?? 0) > 0,
    );
    let latestExpansionId: number | null = null;
    let latestExpansionInstances: typeof expansionsWithProgress[number]["instances"] = [];
    for (const e of expansionsWithProgress) {
      const id = e.expansion?.id ?? -1;
      if (latestExpansionId === null || id > latestExpansionId) {
        latestExpansionId = id;
        latestExpansionInstances = e.instances;
      }
    }

    // Flatten into a compact completion list the raid_completion widget can
    // render directly: [{ instanceId, difficulty, completedCount, totalCount }].
    const completions = (latestExpansionInstances ?? []).flatMap((inst) =>
      (inst.modes ?? []).map((m) => ({
        instanceId: inst.instance?.id ?? null,
        instanceName:
          typeof inst.instance?.name === "string" ? inst.instance.name : null,
        difficultyType: m.difficulty?.type ?? null,
        completedCount: m.progress?.completed_count ?? 0,
        totalCount: m.progress?.total_count ?? 0,
        encounters:
          m.progress?.encounters?.map((enc) => ({
            id: enc.encounter?.id ?? null,
            name:
              typeof enc.encounter?.name === "string" ? enc.encounter.name : null,
            kills: enc.completed_count ?? 0,
            lastKillTimestamp: enc.last_kill_timestamp ?? null,
          })) ?? [],
      })),
    );

    await writeRaidSnapshot({
      characterId: character.id,
      source: "BLIZZARD",
      capturedAt,
      expansionId: latestExpansionId ?? null,
      tierId: null, // Blizzard doesn't expose a "tier id" — derived elsewhere.
      completions,
      rawPayload: raids,
    });
  } catch (err) {
    logSnapshotError(err, { stage: "raids", characterId: character.id });
  }

  // 4. Mythic+ profile. Blizzard's API needs a season id on the per-season
  //    endpoint, so we hit the unsuffixed index first to discover the current
  //    season and read the overall rating, then fetch /season/{id} for the
  //    weekly highest + best-runs list.
  try {
    const mplusIndex = await client.request(
      endpoints.characterMythicKeystoneIndex(
        region,
        character.realmSlug,
        character.name,
      ),
      {
        region,
        schema: mythicKeystoneIndexResponseSchema,
        auth: { kind: "app" },
        minFloor: 5,
      },
    );

    // "Current season" = max season id present in the index's seasons array.
    // Each entry's id is either the literal id or the trailing number on the
    // key.href URL (the older shape).
    let currentSeasonId: number | null = null;
    for (const s of mplusIndex.seasons ?? []) {
      let id: number | null = null;
      if (typeof s.id === "number") id = s.id;
      else if (typeof s.key?.href === "string") {
        const match = s.key.href.match(/\/season\/(\d+)/);
        if (match) id = Number(match[1]);
      }
      if (id !== null && (currentSeasonId === null || id > currentSeasonId)) {
        currentSeasonId = id;
      }
    }

    if (currentSeasonId !== null) {
      const season = await client.request(
        endpoints.characterMythicKeystone(
          region,
          character.realmSlug,
          character.name,
          currentSeasonId,
        ),
        {
          region,
          schema: mythicKeystoneSeasonResponseSchema,
          auth: { kind: "app" },
          minFloor: 5,
        },
      );

      const currentRating = mplusIndex.current_mythic_rating?.rating ?? null;
      const bestRuns = season.best_runs ?? [];
      const weeklyHighest = bestRuns.reduce(
        (max, r) => Math.max(max, r.keystone_level ?? 0),
        0,
      );

      await writeMplusSnapshot({
        characterId: character.id,
        source: "BLIZZARD",
        capturedAt,
        seasonId: currentSeasonId,
        currentRating,
        weeklyHighest: weeklyHighest || null,
        runsThisWeek: bestRuns.map((r) => ({
          level: r.keystone_level ?? null,
          timed: r.is_completed_within_time ?? null,
          dungeonId: r.dungeon?.id ?? null,
          dungeonName:
            typeof r.dungeon?.name === "string" ? r.dungeon.name : null,
          completedAt: r.completed_timestamp ?? null,
          durationMs: r.duration ?? null,
        })),
        rawPayload: { index: mplusIndex, season },
      });
    }
  } catch (err) {
    logSnapshotError(err, { stage: "mplus", characterId: character.id });
  }

  // 5. Great Vault — derived from the M+ and raid data we just persisted.
  //    Vault eligibility rules (current expansion):
  //      M+ track:    1 timed run = slot 1, 4 = slot 2, 8 = slot 3
  //      Raid track:  2 boss kills (any difficulty) = slot 1, 4 = slot 2,
  //                   6 = slot 3
  //      World track: needs Delve/world-quest data we don't ingest yet —
  //                   reported as 0/0.
  //    Best-effort: we count distinct dungeon entries in best_runs and the
  //    sum of boss kills in the latest raid completions. If the player has
  //    repeats the count slightly underestimates; the widget treats this as
  //    an approximate vault preview, not a guarantee.
  try {
    const [latestMplus, latestRaid] = await Promise.all([
      db.mplusSnapshot.findFirst({
        where: { characterId: character.id, source: "BLIZZARD" },
        orderBy: { capturedAt: "desc" },
        select: { runsThisWeek: true },
      }),
      db.raidSnapshot.findFirst({
        where: { characterId: character.id, source: "BLIZZARD" },
        orderBy: { capturedAt: "desc" },
        select: { completions: true },
      }),
    ]);

    const mplusRunsArray = Array.isArray(latestMplus?.runsThisWeek)
      ? (latestMplus?.runsThisWeek as unknown[])
      : [];
    const mplusRuns = mplusRunsArray.length;
    const mplusSlots =
      mplusRuns >= 8 ? 3 : mplusRuns >= 4 ? 2 : mplusRuns >= 1 ? 1 : 0;

    const completions = Array.isArray(latestRaid?.completions)
      ? (latestRaid?.completions as Array<{ encounters?: Array<{ kills?: number }> }>)
      : [];
    // Total distinct boss kills across all difficulties — count each kill
    // record where kills>0 in the latest expansion only (already filtered).
    const raidKills = completions.reduce(
      (sum, entry) =>
        sum +
        (entry.encounters?.filter((e) => (e.kills ?? 0) > 0).length ?? 0),
      0,
    );
    const raidSlots =
      raidKills >= 6 ? 3 : raidKills >= 4 ? 2 : raidKills >= 2 ? 1 : 0;

    // weekStart: Tuesday 15:00 UTC of the current week (US reset). Cheap
    // calc — find the previous Tuesday and pin to 15:00 UTC.
    const now = new Date();
    const weekStart = new Date(now);
    const daysSinceTuesday = (now.getUTCDay() - 2 + 7) % 7;
    weekStart.setUTCDate(now.getUTCDate() - daysSinceTuesday);
    weekStart.setUTCHours(15, 0, 0, 0);
    if (weekStart > now) weekStart.setUTCDate(weekStart.getUTCDate() - 7);

    await writeVaultSnapshot({
      characterId: character.id,
      source: "BLIZZARD",
      capturedAt,
      weekStart,
      slots: {
        raid: { unlocked: raidSlots, total: 3 },
        mythicPlus: { unlocked: mplusSlots, total: 3 },
        world: { unlocked: 0, total: 0 },
      },
      rawPayload: { mplusRuns, raidKills, derivedAt: capturedAt.toISOString() },
    });
  } catch (err) {
    logSnapshotError(err, { stage: "vault", characterId: character.id });
  }

  // Still deferred: WCL parses (separate GraphQL pipeline), Raider.IO.
}

const regionToCode = (r: Region): string => r.toLowerCase();

const hourKey = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`;
};
