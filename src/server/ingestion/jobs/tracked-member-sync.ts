import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { queues, QUEUE_NAMES } from "@/server/ingestion/queues";
import { blizzardClient } from "@/server/ingestion/blizzard/client";
import { endpoints } from "@/server/ingestion/blizzard/endpoints";
import {
  characterSummaryResponseSchema,
} from "@/server/ingestion/blizzard/schemas";
import {
  writeCharacterSnapshot,
  writeEquipmentSnapshot,
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
const equipmentItemSchema = z
  .object({
    slot: z.object({ type: z.string() }).passthrough().optional(),
    item: z.object({ id: z.number() }).passthrough().optional(),
    level: z.object({ value: z.number().optional() }).passthrough().optional(),
    enchantments: z.array(z.unknown()).optional(),
    sockets: z.array(z.unknown()).optional(),
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

    await writeCharacterSnapshot({
      characterId: character.id,
      source: "BLIZZARD",
      capturedAt,
      itemLevel,
      level: summary.level ?? null,
      specId: null,
      specName: null,
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

    await writeEquipmentSnapshot({
      characterId: character.id,
      source: "BLIZZARD",
      capturedAt,
      itemLevel: equipment.equipped_item_level ?? null,
      missingEnchantsCount,
      missingGemsCount,
      tierSetPiecesCount: null, // Phase 4.x: derive from item-set ids.
      tierSetIds: [],
      items: equipment.equipped_items,
      rawPayload: equipment,
    });
  } catch (err) {
    logSnapshotError(err, { stage: "equipment", characterId: character.id });
  }

  // Phase 4.x: M+ profile, raid encounters, vault, WCL parses, Raider.IO.
}

const regionToCode = (r: Region): string => r.toLowerCase();

const hourKey = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`;
};
