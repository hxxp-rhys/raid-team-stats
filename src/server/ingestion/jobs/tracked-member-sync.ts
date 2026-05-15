import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { queues, QUEUE_NAMES } from "@/server/ingestion/queues";
import { blizzardClient } from "@/server/ingestion/blizzard/client";
import { endpoints } from "@/server/ingestion/blizzard/endpoints";
import {
  characterSummaryResponseSchema,
  raidEncountersResponseSchema,
} from "@/server/ingestion/blizzard/schemas";
import {
  writeCharacterSnapshot,
  writeEquipmentSnapshot,
  writeRaidSnapshot,
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

  // Phase 4.x remaining: M+ profile (needs season selector), vault, WCL,
  // Raider.IO.
}

const regionToCode = (r: Region): string => r.toLowerCase();

const hourKey = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`;
};
