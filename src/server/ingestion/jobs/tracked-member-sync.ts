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
  writeWclParseSnapshot,
  logSnapshotError,
} from "@/server/ingestion/snapshots";
import { warcraftLogsClient } from "@/server/ingestion/warcraftlogs/client";
import {
  CHARACTER_ZONE_RANKINGS_QUERY,
  characterZoneRankingsResponseSchema,
  buildCharacterEncounterRankingsQuery,
  characterEncounterRankingsResponseSchema,
} from "@/server/ingestion/warcraftlogs/queries";
import {
  raiderIOClient,
  characterProfileFields,
} from "@/server/ingestion/raiderio/client";
import { raiderIOCharacterProfileSchema } from "@/server/ingestion/raiderio/schemas";
import { resolveWorldVault } from "@/server/ingestion/wowaudit/world-vault";
import { computeGearAudit } from "@/server/ingestion/gear-audit";
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
      opts: { jobId: `tier-a_${c.id}_${hourKey()}` },
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
    // A socketed item exposes one entry per socket. A FILLED socket has an
    // `item` (the gem); an EMPTY socket has `socket_type` but no `item`.
    sockets: z
      .array(
        z
          .object({
            socket_type: z
              .object({ type: z.string() })
              .passthrough()
              .optional(),
            item: z.object({ id: z.number() }).passthrough().optional(),
          })
          .passthrough(),
      )
      .optional(),
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

  // 0. Raider.IO profile — fetched ONCE up-front (rate-limit friendly) and
  // reused by the raid (season progression) and M+ (canonical score + exact
  // weekly runs) steps below. Raider.IO is the authoritative source for the
  // community M+ score and a clean season raid_progression summary.
  type RioProfile = z.infer<typeof raiderIOCharacterProfileSchema> | null;
  let rioProfile: RioProfile = null;
  try {
    const rio = raiderIOClient();
    rioProfile = await rio.get({
      path: "/characters/profile",
      query: {
        region: regionToCode(character.region),
        realm: character.realmSlug,
        name: character.name,
        fields: characterProfileFields(
          "mythic_plus_scores_by_season:current",
          "mythic_plus_recent_runs",
          "mythic_plus_weekly_highest_level_runs",
          "raid_progression",
          "gear",
        ),
      },
      schema: raiderIOCharacterProfileSchema,
    });
  } catch (err) {
    logger.warn(
      { err, character: character.name },
      "raiderio profile fetch failed; Blizzard-only fallbacks apply",
    );
  }

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

    // Missing enchants / empty sockets — Midnight-correct slot logic lives
    // in the shared gear-audit helper (also used by the snapshot router so
    // the widget's hover detail and these stored counts never diverge).
    const { missingEnchantsCount, missingGemsCount } = computeGearAudit(
      equipment.equipped_items,
    );

    // Tier set lives in exactly these five armor slots. Restricting the
    // count to them avoids miscounting non-tier "sets" (e.g. ring/trinket
    // sets) that Blizzard models with the same `set` field.
    const TIER_SLOTS = ["HEAD", "SHOULDER", "CHEST", "HANDS", "LEGS"] as const;
    type TierSlot = (typeof TIER_SLOTS)[number];

    // ilvl → reward track band (TWW retail bands). Lower/squished test data
    // buckets to veteran; production ilvls map correctly.
    const ilvlTrack = (
      ilvl: number | null | undefined,
    ): "veteran" | "champion" | "hero" | "myth" | null => {
      if (typeof ilvl !== "number" || ilvl <= 0) return null;
      if (ilvl >= 707) return "myth";
      if (ilvl >= 694) return "hero";
      if (ilvl >= 681) return "champion";
      return "veteran";
    };

    // Tally tier-set pieces per set id, but only across the five tier slots.
    const tierPiecesBySet = new Map<number, number>();
    for (const item of equipment.equipped_items) {
      const slot = item.slot?.type;
      const setId = item.set?.item_set?.id;
      if (
        typeof setId === "number" &&
        slot &&
        (TIER_SLOTS as readonly string[]).includes(slot)
      ) {
        tierPiecesBySet.set(setId, (tierPiecesBySet.get(setId) ?? 0) + 1);
      }
    }
    const tierSetIds = Array.from(tierPiecesBySet.keys()).sort();
    const dominantSetId =
      tierPiecesBySet.size === 0
        ? null
        : [...tierPiecesBySet.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const tierSetPiecesCount = dominantSetId
      ? (tierPiecesBySet.get(dominantSetId) ?? 0)
      : 0;

    // Per-slot breakdown for the dominant set.
    const slotItem = new Map<string, (typeof equipment.equipped_items)[number]>();
    for (const item of equipment.equipped_items) {
      if (item.slot?.type) slotItem.set(item.slot.type, item);
    }
    const tierSlots = TIER_SLOTS.map((slot: TierSlot) => {
      const item = slotItem.get(slot);
      const isTier =
        !!item &&
        dominantSetId != null &&
        item.set?.item_set?.id === dominantSetId;
      const itemLevel = isTier ? (item?.level?.value ?? null) : null;
      return {
        slot,
        filled: isTier,
        itemLevel,
        track: isTier ? ilvlTrack(itemLevel) : null,
      };
    });

    await writeEquipmentSnapshot({
      characterId: character.id,
      source: "BLIZZARD",
      capturedAt,
      itemLevel: equipment.equipped_item_level ?? null,
      missingEnchantsCount,
      missingGemsCount,
      tierSetPiecesCount,
      tierSetIds,
      tierSlots,
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

    // Raider.IO season-cumulative raid_progression. Keyed by raid slug; pick
    // the entry with the most kills (= the current/most-progressed raid) so
    // the widget gets one clean season summary alongside the weekly view.
    let seasonProgress: {
      raid: string;
      summary: string | null;
      total: number | null;
      normal: number | null;
      heroic: number | null;
      mythic: number | null;
    } | null = null;
    const rp = rioProfile?.raid_progression;
    if (rp && typeof rp === "object") {
      for (const [slug, v] of Object.entries(
        rp as Record<string, Record<string, unknown>>,
      )) {
        const n = Number(v?.normal_bosses_killed ?? 0);
        const h = Number(v?.heroic_bosses_killed ?? 0);
        const m = Number(v?.mythic_bosses_killed ?? 0);
        const score = m * 1_000_000 + h * 1_000 + n; // prefer higher diff
        const prevScore = seasonProgress
          ? (seasonProgress.mythic ?? 0) * 1_000_000 +
            (seasonProgress.heroic ?? 0) * 1_000 +
            (seasonProgress.normal ?? 0)
          : -1;
        if (score > prevScore) {
          seasonProgress = {
            raid: slug,
            summary:
              typeof v?.summary === "string" ? v.summary : null,
            total:
              v?.total_bosses != null ? Number(v.total_bosses) : null,
            normal: n,
            heroic: h,
            mythic: m,
          };
        }
      }
    }

    await writeRaidSnapshot({
      characterId: character.id,
      source: "BLIZZARD",
      capturedAt,
      expansionId: latestExpansionId ?? null,
      tierId: null, // Blizzard doesn't expose a "tier id" — derived elsewhere.
      completions,
      seasonProgress,
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

      // Prefer the Raider.IO community season score (the canonical "M+
      // score" players quote); fall back to Blizzard's internal rating
      // only when RIO is unavailable.
      const rioSeasonScores =
        rioProfile?.mythic_plus_scores_by_season?.[0]?.scores ?? null;
      const currentRating =
        rioSeasonScores?.all ??
        mplusIndex.current_mythic_rating?.rating ??
        null;
      // Blizzard's current_period.best_runs is best-per-dungeon for the week
      // (deduplicated) — a LOWER BOUND on the true run count. It's still the
      // right source for each vault slot's item-level track (1st/4th/8th
      // HIGHEST key), so we keep it as `runsThisWeek`.
      const periodRuns = mplusIndex.current_period?.best_runs ?? [];
      const blizzardDistinct = periodRuns.length;
      const weeklyHighest = periodRuns.reduce(
        (max, r) => Math.max(max, r.keystone_level ?? 0),
        0,
      );

      // Weekly reset boundary for this character's region (US Tue 15:00 UTC,
      // EU Wed 07:00 UTC, KR/TW Wed 09:00 UTC ≈ region maintenance windows).
      const weekResetUtc = weeklyResetBefore(new Date(), character.region);

      // Raider.IO recent runs are individual completions (repeats included).
      // Counting those after the weekly reset yields the EXACT vault count in
      // the 0–8 band that matters (≥8 → all 3 slots regardless of overflow).
      // Best-effort: if Raider.IO is unavailable we fall back to the Blizzard
      // distinct count (the lower bound).
      // Raider.IO recent runs were already fetched once at the top of this
      // job (step 0) — reuse that payload, no second HTTP round-trip. If RIO
      // was unavailable we fall back to the Blizzard distinct count.
      let raiderioWeekCount = 0;
      let raiderioWeekHighest = 0;
      const recentRuns = rioProfile?.mythic_plus_recent_runs ?? [];
      for (const r of recentRuns) {
        if (!r.completed_at) continue;
        const t = Date.parse(r.completed_at);
        if (Number.isNaN(t) || t < weekResetUtc.getTime()) continue;
        raiderioWeekCount++;
        raiderioWeekHighest = Math.max(raiderioWeekHighest, r.mythic_level);
      }

      // Both numbers are lower bounds on the true weekly completions; the max
      // is the closest estimate and saturates correctly at the 8-run cap.
      const weeklyRunCount = Math.max(blizzardDistinct, raiderioWeekCount);
      const effectiveWeeklyHighest = Math.max(
        weeklyHighest,
        raiderioWeekHighest,
      );

      await writeMplusSnapshot({
        characterId: character.id,
        source: "BLIZZARD",
        capturedAt,
        seasonId: currentSeasonId,
        currentRating,
        // Full Raider.IO season score breakdown (all / dps / healer / tank /
        // per-spec) — powers the M+ ladder role split.
        rioScore: rioSeasonScores,
        weeklyHighest: effectiveWeeklyHighest || null,
        weeklyRunCount,
        // Per-dungeon best (with keystone_level) — used for each vault slot's
        // item-level track via the 1st/4th/8th highest key.
        runsThisWeek: periodRuns.map((r) => ({
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
        select: { runsThisWeek: true, weeklyRunCount: true },
      }),
      db.raidSnapshot.findFirst({
        where: { characterId: character.id, source: "BLIZZARD" },
        orderBy: { capturedAt: "desc" },
        select: { completions: true },
      }),
    ]);

    // Gear-track classification. Each unlocked vault slot rewards an item on
    // one of four tracks; the widget colours pips by track.
    //   M+ : key level → veteran(<2) / champion(2–5) / hero(6–9) / myth(10+)
    //   Raid: difficulty → LFR=veteran, Normal=champion, Heroic=hero,
    //         Mythic=myth
    type Track = "veteran" | "champion" | "hero" | "myth";
    const mplusTrack = (level: number): Track =>
      level >= 10 ? "myth" : level >= 6 ? "hero" : level >= 2 ? "champion" : "veteran";
    const raidTrack = (difficulty: string): Track => {
      const d = difficulty.toUpperCase();
      if (d === "MYTHIC") return "myth";
      if (d === "HEROIC") return "hero";
      if (d === "NORMAL") return "champion";
      return "veteran"; // LFR / RAID_FINDER / anything else
    };

    const mplusRunsArray = Array.isArray(latestMplus?.runsThisWeek)
      ? (latestMplus?.runsThisWeek as Array<{ level?: number }>)
      : [];
    // Exact weekly run count (repeats included) drives slot UNLOCKS. Fall
    // back to the per-dungeon array length if the column is null (old rows).
    const mplusRuns =
      latestMplus?.weeklyRunCount ?? mplusRunsArray.length;
    const mplusSlots =
      mplusRuns >= 8 ? 3 : mplusRuns >= 4 ? 2 : mplusRuns >= 1 ? 1 : 0;
    // Each slot's item-level TRACK is gated by the 1st / 4th / 8th highest
    // key. Sort the per-dungeon best runs by level desc and read those.
    const sortedLevels = mplusRunsArray
      .map((r) => r.level ?? 0)
      .sort((a, b) => b - a);
    const mplusSlotIndexes = [0, 3, 7]; // 1st, 4th, 8th best
    const mplusTracks: Track[] = [];
    for (let s = 0; s < mplusSlots; s++) {
      const lvl = sortedLevels[mplusSlotIndexes[s]!] ?? 0;
      mplusTracks.push(mplusTrack(lvl));
    }

    const completions = Array.isArray(latestRaid?.completions)
      ? (latestRaid?.completions as Array<{
          difficultyType?: string;
          encounters?: Array<{ kills?: number }>;
        }>)
      : [];
    // Flatten each boss kill into a per-kill difficulty list, then sort by
    // difficulty rank desc — the vault's 2nd/4th/6th-best kills determine the
    // three raid slots' reward tracks.
    const diffRank: Record<string, number> = {
      MYTHIC: 3,
      HEROIC: 2,
      NORMAL: 1,
      LFR: 0,
    };
    const killDifficulties: string[] = [];
    for (const entry of completions) {
      const diff = (entry.difficultyType ?? "NORMAL").toUpperCase();
      const killed = entry.encounters?.filter((e) => (e.kills ?? 0) > 0).length ?? 0;
      for (let k = 0; k < killed; k++) killDifficulties.push(diff);
    }
    killDifficulties.sort((a, b) => (diffRank[b] ?? 0) - (diffRank[a] ?? 0));
    const raidKills = killDifficulties.length;
    const raidSlots =
      raidKills >= 6 ? 3 : raidKills >= 4 ? 2 : raidKills >= 2 ? 1 : 0;
    const raidSlotIndexes = [1, 3, 5]; // 2nd, 4th, 6th kill
    const raidTracks: Track[] = [];
    for (let s = 0; s < raidSlots; s++) {
      const diff = killDifficulties[raidSlotIndexes[s]!] ?? "NORMAL";
      raidTracks.push(raidTrack(diff));
    }

    // weekStart: Tuesday 15:00 UTC of the current week (US reset). Cheap
    // calc — find the previous Tuesday and pin to 15:00 UTC.
    const now = new Date();
    const weekStart = new Date(now);
    const daysSinceTuesday = (now.getUTCDay() - 2 + 7) % 7;
    weekStart.setUTCDate(now.getUTCDate() - daysSinceTuesday);
    weekStart.setUTCHours(15, 0, 0, 0);
    if (weekStart > now) weekStart.setUTCDate(weekStart.getUTCDate() - 7);

    // World (Delve) Great Vault row. Blizzard's public character API does
    // NOT expose Delve/World vault progress, so WoW Audit (fed by its
    // in-game companion addon) is the only reliable source. Resolved per
    // the character's active guild; stays `tracked:false` unless that
    // guild has a WoW Audit key configured AND the character is in its
    // WoW Audit roster with a usable vault signal.
    let world: {
      unlocked: number;
      total: number;
      tracks: Track[];
      tracked: boolean;
    } = { unlocked: 0, total: 3, tracks: [], tracked: false };
    try {
      const link = await db.guildCharacterLink.findFirst({
        where: { characterId: character.id, status: "ACTIVE" },
        select: { guildId: true },
      });
      if (link) {
        const wv = await resolveWorldVault({
          guildId: link.guildId,
          name: character.name,
          realmSlug: character.realmSlug,
        });
        if (wv) {
          world = {
            unlocked: wv.unlocked,
            total: wv.total,
            tracks: [],
            tracked: true,
          };
        }
      }
    } catch (err) {
      logger.warn(
        { err, characterId: character.id },
        "world-vault resolve failed; leaving World untracked",
      );
    }

    await writeVaultSnapshot({
      characterId: character.id,
      source: "BLIZZARD",
      capturedAt,
      weekStart,
      slots: {
        raid: { unlocked: raidSlots, total: 3, tracks: raidTracks },
        mythicPlus: { unlocked: mplusSlots, total: 3, tracks: mplusTracks },
        world,
      },
      rawPayload: {
        mplusRuns,
        raidKills,
        mplusTracks,
        raidTracks,
        world,
        derivedAt: capturedAt.toISOString(),
      },
    });
  } catch (err) {
    logSnapshotError(err, { stage: "vault", characterId: character.id });
  }

  // 6. Warcraft Logs parses (Mythic, current raid tier).
  //
  //    Two facts about WCL's API drive the shape here:
  //      • `zoneRankings` is a season/partition-cumulative aggregate with
  //        NO per-kill timestamps — perfect for the heatmap's "best per
  //        boss this tier" but it CANNOT answer "this week".
  //      • `encounterRankings` exposes individual `ranks[]`, each with a
  //        `startTime` — the only way to scope to the current lockout.
  //
  //    So we do both: zoneRankings → `percentile` (season best, heatmap),
  //    and a single batched encounterRankings call → `weekPercentile` +
  //    `reportStartTime` (current-week best, the parses widget).
  //
  //    Zone resolves via `currentRaidZoneId()` (env WCL_RAID_ZONE_ID pin →
  //    Redis cache → live worldData.zones). Prod pins 46 (live Midnight).
  try {
    const wcl = warcraftLogsClient();
    const zoneID = (await wcl.currentRaidZoneId()) ?? 46;
    const MYTHIC_DIFFICULTY = 5; // WCL difficulty 5 = Mythic

    // Current raid lockout window: US weekly reset is Tuesday 15:00 UTC
    // (= "Tuesday 11:00" US Eastern, what the user specified). Matches the
    // vault snapshot's weekStart anchor.
    const wkNow = Date.now();
    const wkStart = new Date(wkNow);
    const daysSinceTue = (wkStart.getUTCDay() - 2 + 7) % 7;
    wkStart.setUTCDate(wkStart.getUTCDate() - daysSinceTue);
    wkStart.setUTCHours(15, 0, 0, 0);
    if (wkStart.getTime() > wkNow)
      wkStart.setUTCDate(wkStart.getUTCDate() - 7);
    const weekStartMs = wkStart.getTime();
    const weekEndMs = weekStartMs + 7 * 24 * 60 * 60 * 1000;

    const wclRegion = regionToCode(character.region).toUpperCase();

    // (a) Season-best per encounter for the heatmap.
    const zoneResp = await wcl.query({
      query: CHARACTER_ZONE_RANKINGS_QUERY,
      variables: {
        name: character.name,
        server: character.realmSlug,
        region: wclRegion,
        zoneID,
        metric: "dps",
        difficulty: MYTHIC_DIFFICULTY,
      },
      schema: characterZoneRankingsResponseSchema,
      estimatedPoints: 5,
    });
    type ZoneRanking = {
      encounter?: { id?: number; name?: string };
      rankPercent?: number | null;
      bestPercent?: number | null;
    };
    const zr = zoneResp.characterData?.character?.zoneRankings as
      | { rankings?: ZoneRanking[] }
      | null
      | undefined;
    const seasonRankings = zr?.rankings ?? [];
    const encounters: Array<{ id: number; name: string | null }> = [];
    for (const r of seasonRankings) {
      const id = r.encounter?.id;
      if (typeof id === "number") {
        encounters.push({ id, name: r.encounter?.name ?? null });
      }
    }

    // (b) One batched encounterRankings call → per-kill ranks with times.
    type Rank = {
      startTime?: number | null;
      rankPercent?: number | null;
      percentile?: number | null;
      report?: { code?: string | null; startTime?: number | null } | null;
    };
    let charEnc: Record<string, unknown> = {};
    if (encounters.length > 0) {
      const encResp = await wcl.query({
        query: buildCharacterEncounterRankingsQuery(
          encounters.map((e) => e.id),
        ),
        variables: {
          name: character.name,
          server: character.realmSlug,
          region: wclRegion,
          difficulty: MYTHIC_DIFFICULTY,
        },
        schema: characterEncounterRankingsResponseSchema,
        estimatedPoints: Math.max(5, encounters.length),
      });
      charEnc = (encResp.characterData?.character ?? {}) as Record<
        string,
        unknown
      >;
    }

    for (const enc of encounters) {
      const season = seasonRankings.find((r) => r.encounter?.id === enc.id);
      const seasonPct = season?.rankPercent ?? season?.bestPercent ?? null;

      const er = charEnc[`e${enc.id}`] as
        | { ranks?: Rank[] }
        | null
        | undefined;
      const ranks = Array.isArray(er?.ranks) ? er.ranks : [];
      let weekBest: number | null = null;
      let weekBestStart: number | null = null;
      let weekBestReport: string | null = null;
      for (const rk of ranks) {
        const t =
          typeof rk.startTime === "number"
            ? rk.startTime
            : typeof rk.report?.startTime === "number"
              ? rk.report.startTime
              : null;
        if (t == null || t < weekStartMs || t >= weekEndMs) continue;
        const pct = rk.rankPercent ?? rk.percentile ?? null;
        if (pct == null) continue;
        if (weekBest == null || pct > weekBest) {
          weekBest = pct;
          weekBestStart = t;
          weekBestReport = rk.report?.code ?? null;
        }
      }

      await writeWclParseSnapshot({
        characterId: character.id,
        capturedAt,
        zoneId: zoneID,
        encounterId: enc.id,
        encounterName: enc.name ?? null,
        difficulty: MYTHIC_DIFFICULTY,
        percentile:
          seasonPct != null ? Math.round(seasonPct * 100) / 100 : null,
        weekPercentile:
          weekBest != null ? Math.round(weekBest * 100) / 100 : null,
        metric: "dps",
        reportCode: weekBestReport,
        reportStartTime:
          weekBestStart != null ? new Date(weekBestStart) : null,
        rawPayload: { season, weekRanks: ranks.length },
      });
    }
  } catch (err) {
    logSnapshotError(err, { stage: "wcl", characterId: character.id });
  }

  // Still deferred: Raider.IO (mostly duplicates Blizzard data — defer until
  // we surface gear-snapshot percentile rankings the API uniquely provides).
}

const regionToCode = (r: Region): string => r.toLowerCase();

/**
 * Most recent weekly-reset instant (UTC) at or before `now` for the region.
 * Reset windows (approx, post-maintenance):
 *   US     → Tuesday 15:00 UTC
 *   EU     → Wednesday 07:00 UTC
 *   KR/TW  → Wednesday 09:00 UTC
 * Used to bound "this week's" M+ runs for exact Great Vault counting.
 */
function weeklyResetBefore(now: Date, region: Region): Date {
  const cfg: Record<Region, { day: number; hour: number }> = {
    US: { day: 2, hour: 15 }, // Tue
    EU: { day: 3, hour: 7 }, // Wed
    KR: { day: 3, hour: 9 }, // Wed
    TW: { day: 3, hour: 9 }, // Wed
  };
  const { day, hour } = cfg[region] ?? cfg.US;
  const d = new Date(now);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(0);
  // Walk back day-by-day to the most recent matching weekday at `hour`.
  for (let i = 0; i < 8; i++) {
    if (d.getUTCDay() === day) {
      const reset = new Date(d);
      reset.setUTCHours(hour, 0, 0, 0);
      if (reset.getTime() <= now.getTime()) return reset;
    }
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(23, 0, 0, 0);
  }
  // Fallback — 7 days ago (shouldn't be reached).
  return new Date(now.getTime() - 7 * 24 * 3_600_000);
}

const hourKey = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`;
};
