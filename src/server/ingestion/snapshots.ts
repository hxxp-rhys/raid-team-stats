import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { SnapshotSource } from "@/generated/prisma/enums";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Per-domain snapshot writers. Each writer:
 *   1. Computes a deterministic hash of the canonical payload.
 *   2. Looks up the most recent snapshot for (characterId, source).
 *   3. Skips the insert if the hash matches — `noop` for idempotent re-runs.
 *   4. Otherwise inserts a new immutable row.
 *
 * Snapshots are immutable: updates mean a fresh row, not a mutation of an
 * existing one. Retention is handled by a separate compaction job (Phase 6).
 */

/**
 * JSON.stringify replacer that coerces BigInt (from Blizzard character IDs)
 * into decimal strings. Necessary because Prisma's Json columns can't
 * round-trip BigInt and because JSON.stringify throws on bare bigints.
 */
const jsonReplacer = (_k: string, v: unknown): unknown =>
  typeof v === "bigint" ? v.toString() : v;

const safeStringify = (value: unknown): string =>
  JSON.stringify(value, jsonReplacer);

/**
 * Coerce a value into Prisma.InputJsonValue territory by stripping bigints.
 * The result is the same JSON shape but with all bigints → strings.
 */
export const toJsonValue = <T>(value: T): Prisma.InputJsonValue =>
  JSON.parse(safeStringify(value)) as Prisma.InputJsonValue;

export const canonicalHash = (payload: unknown): string =>
  createHash("sha256").update(safeStringify(payload)).digest("hex").slice(0, 32);

type Result = { inserted: boolean; reason?: "dedup" };

type CharacterArgs = {
  characterId: string;
  source: SnapshotSource;
  capturedAt: Date;
  itemLevel?: number | null;
  level?: number | null;
  specId?: number | null;
  specName?: string | null;
  loadoutText?: string | null;
  rawPayload: unknown;
};
export async function writeCharacterSnapshot(args: CharacterArgs): Promise<Result> {
  const sourceHash = canonicalHash({
    s: args.source,
    iLvl: args.itemLevel ?? null,
    lvl: args.level ?? null,
    spec: args.specId ?? null,
    loadout: args.loadoutText ?? null,
  });
  const recent = await db.characterSnapshot.findFirst({
    where: { characterId: args.characterId, source: args.source },
    orderBy: { capturedAt: "desc" },
    select: { sourceHash: true },
  });
  if (recent?.sourceHash === sourceHash) return { inserted: false, reason: "dedup" };

  await db.characterSnapshot.create({
    data: {
      characterId: args.characterId,
      capturedAt: args.capturedAt,
      source: args.source,
      sourceHash,
      itemLevel: args.itemLevel ?? null,
      level: args.level ?? null,
      specId: args.specId ?? null,
      specName: args.specName ?? null,
      loadoutText: args.loadoutText ?? null,
      rawPayload: toJsonValue(args.rawPayload) as Prisma.InputJsonValue,
    },
  });
  return { inserted: true };
}

type EquipmentArgs = {
  characterId: string;
  source: SnapshotSource;
  capturedAt: Date;
  itemLevel?: number | null;
  missingEnchantsCount?: number | null;
  missingGemsCount?: number | null;
  tierSetPiecesCount?: number | null;
  tierSetIds?: number[];
  tierSlots?: unknown;
  items: unknown;
  rawPayload: unknown;
};
export async function writeEquipmentSnapshot(args: EquipmentArgs): Promise<Result> {
  const sourceHash = canonicalHash({
    s: args.source,
    iLvl: args.itemLevel ?? null,
    missingEnch: args.missingEnchantsCount ?? null,
    missingGems: args.missingGemsCount ?? null,
    tier: args.tierSetPiecesCount ?? null,
    tierIds: args.tierSetIds ?? [],
    items: args.items,
  });
  const recent = await db.equipmentSnapshot.findFirst({
    where: { characterId: args.characterId, source: args.source },
    orderBy: { capturedAt: "desc" },
    select: { sourceHash: true },
  });
  if (recent?.sourceHash === sourceHash) return { inserted: false, reason: "dedup" };

  await db.equipmentSnapshot.create({
    data: {
      characterId: args.characterId,
      capturedAt: args.capturedAt,
      source: args.source,
      sourceHash,
      itemLevel: args.itemLevel ?? null,
      missingEnchantsCount: args.missingEnchantsCount ?? null,
      missingGemsCount: args.missingGemsCount ?? null,
      tierSetPiecesCount: args.tierSetPiecesCount ?? null,
      tierSetIds: args.tierSetIds ?? [],
      tierSlots:
        args.tierSlots == null
          ? undefined
          : (toJsonValue(args.tierSlots) as Prisma.InputJsonValue),
      items: toJsonValue(args.items) as Prisma.InputJsonValue,
      rawPayload: toJsonValue(args.rawPayload) as Prisma.InputJsonValue,
    },
  });
  return { inserted: true };
}

type MplusArgs = {
  characterId: string;
  source: SnapshotSource;
  capturedAt: Date;
  seasonId: number;
  currentRating?: number | null;
  weeklyHighest?: number | null;
  weeklyRunCount?: number | null;
  rioScore?: unknown;
  previousSeasonRating?: number | null;
  previousSeasonSlug?: string | null;
  runsThisWeek: unknown;
  rawPayload: unknown;
};
export async function writeMplusSnapshot(args: MplusArgs): Promise<Result> {
  const sourceHash = canonicalHash({
    s: args.source,
    season: args.seasonId,
    rating: args.currentRating ?? null,
    weekly: args.weeklyHighest ?? null,
    weeklyCount: args.weeklyRunCount ?? null,
    rio: args.rioScore ?? null,
    prevRating: args.previousSeasonRating ?? null,
    prevSlug: args.previousSeasonSlug ?? null,
    runs: args.runsThisWeek,
  });
  const recent = await db.mplusSnapshot.findFirst({
    where: {
      characterId: args.characterId,
      source: args.source,
      seasonId: args.seasonId,
    },
    orderBy: { capturedAt: "desc" },
    select: { sourceHash: true },
  });
  if (recent?.sourceHash === sourceHash) return { inserted: false, reason: "dedup" };

  await db.mplusSnapshot.create({
    data: {
      characterId: args.characterId,
      capturedAt: args.capturedAt,
      source: args.source,
      sourceHash,
      seasonId: args.seasonId,
      currentRating:
        args.currentRating != null ? args.currentRating.toString() : null,
      weeklyHighest: args.weeklyHighest ?? null,
      weeklyRunCount: args.weeklyRunCount ?? null,
      rioScore:
        args.rioScore == null
          ? undefined
          : (toJsonValue(args.rioScore) as Prisma.InputJsonValue),
      previousSeasonRating:
        args.previousSeasonRating != null
          ? args.previousSeasonRating.toString()
          : null,
      previousSeasonSlug: args.previousSeasonSlug ?? null,
      runsThisWeek: toJsonValue(args.runsThisWeek) as Prisma.InputJsonValue,
      rawPayload: toJsonValue(args.rawPayload) as Prisma.InputJsonValue,
    },
  });
  return { inserted: true };
}

type RaidArgs = {
  characterId: string;
  source: SnapshotSource;
  capturedAt: Date;
  expansionId?: number | null;
  tierId?: number | null;
  completions: unknown;
  seasonProgress?: unknown;
  rawPayload: unknown;
};
export async function writeRaidSnapshot(args: RaidArgs): Promise<Result> {
  const sourceHash = canonicalHash({
    s: args.source,
    exp: args.expansionId ?? null,
    tier: args.tierId ?? null,
    comp: args.completions,
    sp: args.seasonProgress ?? null,
  });
  const recent = await db.raidSnapshot.findFirst({
    where: { characterId: args.characterId, source: args.source },
    orderBy: { capturedAt: "desc" },
    select: { sourceHash: true },
  });
  if (recent?.sourceHash === sourceHash) return { inserted: false, reason: "dedup" };

  await db.raidSnapshot.create({
    data: {
      characterId: args.characterId,
      capturedAt: args.capturedAt,
      source: args.source,
      sourceHash,
      expansionId: args.expansionId ?? null,
      tierId: args.tierId ?? null,
      completions: toJsonValue(args.completions) as Prisma.InputJsonValue,
      seasonProgress:
        args.seasonProgress == null
          ? undefined
          : (toJsonValue(args.seasonProgress) as Prisma.InputJsonValue),
      rawPayload: toJsonValue(args.rawPayload) as Prisma.InputJsonValue,
    },
  });
  return { inserted: true };
}

type VaultArgs = {
  characterId: string;
  source: SnapshotSource;
  capturedAt: Date;
  weekStart: Date;
  slots: unknown;
  rawPayload: unknown;
};
export async function writeVaultSnapshot(args: VaultArgs): Promise<Result> {
  const sourceHash = canonicalHash({
    s: args.source,
    week: args.weekStart.toISOString(),
    slots: args.slots,
  });
  // VaultSnapshot has a unique (characterId, weekStart) — update-in-place
  // when the same week is observed again with new content.
  const existing = await db.vaultSnapshot.findUnique({
    where: {
      characterId_weekStart: {
        characterId: args.characterId,
        weekStart: args.weekStart,
      },
    },
    select: { sourceHash: true },
  });
  if (existing?.sourceHash === sourceHash) return { inserted: false, reason: "dedup" };

  await db.vaultSnapshot.upsert({
    where: {
      characterId_weekStart: {
        characterId: args.characterId,
        weekStart: args.weekStart,
      },
    },
    create: {
      characterId: args.characterId,
      capturedAt: args.capturedAt,
      source: args.source,
      sourceHash,
      weekStart: args.weekStart,
      slots: toJsonValue(args.slots) as Prisma.InputJsonValue,
      rawPayload: toJsonValue(args.rawPayload) as Prisma.InputJsonValue,
    },
    update: {
      capturedAt: args.capturedAt,
      source: args.source,
      sourceHash,
      slots: toJsonValue(args.slots) as Prisma.InputJsonValue,
      rawPayload: toJsonValue(args.rawPayload) as Prisma.InputJsonValue,
    },
  });
  return { inserted: true };
}

type WclParseArgs = {
  characterId: string;
  capturedAt: Date;
  zoneId: number;
  encounterId: number;
  encounterName?: string | null;
  difficulty: number;
  percentile?: number | null;
  weekPercentile?: number | null;
  medianPercentile?: number | null;
  bestAvg?: number | null;
  medianAvg?: number | null;
  metric?: string | null;
  reportCode?: string | null;
  reportStartTime?: Date | null;
  rawPayload: unknown;
};
export async function writeWclParseSnapshot(args: WclParseArgs): Promise<Result> {
  // Zone-level bestAvg/medianAvg are deliberately NOT hashed: they drift
  // whenever ANY boss's percentile recalculates and are stamped onto every
  // encounter row — hashing them would rewrite a character's full encounter
  // set (ranks[] payload included) on every zone-number wiggle. They still
  // refresh whenever a per-encounter value genuinely changes; readers
  // tolerate the staleness by taking the latest row that carries them.
  const sourceHash = canonicalHash({
    z: args.zoneId,
    e: args.encounterId,
    n: args.encounterName ?? null,
    d: args.difficulty,
    p: args.percentile ?? null,
    wp: args.weekPercentile ?? null,
    mp: args.medianPercentile ?? null,
    m: args.metric ?? null,
    r: args.reportCode ?? null,
    rt: args.reportStartTime ? args.reportStartTime.getTime() : null,
  });
  const recent = await db.wclParseSnapshot.findFirst({
    where: {
      characterId: args.characterId,
      encounterId: args.encounterId,
      difficulty: args.difficulty,
    },
    orderBy: { capturedAt: "desc" },
    select: { sourceHash: true },
  });
  if (recent?.sourceHash === sourceHash) return { inserted: false, reason: "dedup" };

  await db.wclParseSnapshot.create({
    data: {
      characterId: args.characterId,
      capturedAt: args.capturedAt,
      source: "WARCRAFT_LOGS",
      sourceHash,
      zoneId: args.zoneId,
      encounterId: args.encounterId,
      encounterName: args.encounterName ?? null,
      difficulty: args.difficulty,
      percentile: args.percentile ?? null,
      weekPercentile: args.weekPercentile ?? null,
      medianPercentile: args.medianPercentile ?? null,
      bestAvg: args.bestAvg ?? null,
      medianAvg: args.medianAvg ?? null,
      metric: args.metric ?? null,
      reportCode: args.reportCode ?? null,
      reportStartTime: args.reportStartTime ?? null,
      rawPayload: toJsonValue(args.rawPayload) as Prisma.InputJsonValue,
    },
  });
  return { inserted: true };
}

type ProfessionArgs = {
  characterId: string;
  source: SnapshotSource;
  capturedAt: Date;
  /** Compact derived list (see professions-logic.deriveProfessions). */
  professions: unknown;
  rawPayload: unknown;
};
export async function writeProfessionSnapshot(args: ProfessionArgs): Promise<Result> {
  // Hash the DERIVED list (not the 65 KB raw) — that's what readers consume, so
  // a new row is written exactly when a displayed value changes (level a tier,
  // learn a recipe, gain a profession).
  const sourceHash = canonicalHash({ s: args.source, p: args.professions });
  const recent = await db.professionSnapshot.findFirst({
    where: { characterId: args.characterId, source: args.source },
    orderBy: { capturedAt: "desc" },
    select: { sourceHash: true },
  });
  if (recent?.sourceHash === sourceHash) return { inserted: false, reason: "dedup" };

  await db.professionSnapshot.create({
    data: {
      characterId: args.characterId,
      capturedAt: args.capturedAt,
      source: args.source,
      sourceHash,
      professions: toJsonValue(args.professions) as Prisma.InputJsonValue,
      rawPayload: toJsonValue(args.rawPayload) as Prisma.InputJsonValue,
    },
  });
  return { inserted: true };
}

/**
 * Convenience: log a write error without bubbling — used by Tier A workers
 * that should keep going across a per-character partial failure.
 */
export function logSnapshotError(err: unknown, ctx: Record<string, unknown>): void {
  logger.error({ err, ...ctx }, "snapshot write failed");
}
