import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { warcraftLogsClient } from "@/server/ingestion/warcraftlogs/client";
import {
  WORLD_DATA_FULL_QUERY,
  worldDataFullResponseSchema,
} from "@/server/ingestion/warcraftlogs/queries";
import {
  isRaidZone,
  pickCurrentReleaseRaidZones,
  type WorldDataZone,
} from "@/server/ingestion/warcraftlogs/world-data";

/**
 * Persist the full WCL `worldData` snapshot to `WclZone` and maintain the
 * `isCurrentRaid` flags — the durable, self-updating replacement for the
 * hand-maintained `WCL_RAID_ZONE_ID` env pin.
 *
 * Tracks the whole CURRENT RELEASE: ALL non-frozen raid zones in the current
 * expansion get `isCurrentRaid=true` (e.g. Midnight 12.0.7 → zones 46 + 50),
 * because patches ADD raids to a release and only a `.release` bump replaces
 * the set (WCL freezes the prior release's raids then).
 *
 * Runs at worker startup + every 6h (see worker.ts). One ~5pt WCL query for
 * the whole snapshot, plus a ~3pt reports probe only for a NEWLY-appearing
 * release zone. Idempotent: upserts every zone, then reconciles the flags.
 *
 * SAFETY GATE: a newly-appearing release raid is only adopted once it has ≥1
 * public report — so a PTR / next-release zone WCL publishes early can't get
 * tracked before it's live. Already-tracked zones stay until they freeze.
 *
 * Never throws on the WCL/DB happy path failing — the caller (a startup/timer
 * sweep) logs + moves on; the resolver's live fallback still works meanwhile.
 */
export async function runWorldDataRefresh(): Promise<{
  zones: number;
  currentRaidZoneIds: number[];
  changed: boolean;
}> {
  const wcl = warcraftLogsClient();
  const res = await wcl.query({
    query: WORLD_DATA_FULL_QUERY,
    schema: worldDataFullResponseSchema,
    estimatedPoints: 5,
  });
  const zones = (res.worldData?.zones ?? []) as WorldDataZone[];
  if (zones.length === 0) {
    logger.warn({}, "worldData refresh: WCL returned no zones; skipping");
    return { zones: 0, currentRaidZoneIds: [], changed: false };
  }

  const now = new Date();
  for (const z of zones) {
    const difficulties = (z.difficulties ?? []).map((d) => ({
      id: d.id,
      name: d.name ?? null,
    }));
    const encounters = (z.encounters ?? []).map((e) => ({
      id: e.id,
      name: e.name ?? `Encounter ${e.id}`,
    }));
    const common = {
      name: z.name ?? `Zone ${z.id}`,
      frozen: z.frozen === true,
      expansionId: z.expansion?.id ?? null,
      expansionName: z.expansion?.name ?? null,
      isRaid: isRaidZone(z),
      difficulties,
      encounters,
      refreshedAt: now,
    };
    await db.wclZone.upsert({
      where: { id: z.id },
      create: { id: z.id, isCurrentRaid: false, ...common },
      update: common,
    });
  }

  // Resolve the current RELEASE's raid set (all non-frozen raids in the newest
  // raid's expansion) and reconcile the isCurrentRaid flags against it.
  const releaseSet = pickCurrentReleaseRaidZones(zones);
  if (releaseSet.length === 0) {
    // No live raid resolvable (transient WCL gap) — DON'T clear the flags,
    // keep whatever's tracked so the resolver stays stable.
    logger.warn({}, "worldData refresh: no live raid zone resolved; keeping flags");
    const kept = await db.wclZone.findMany({
      where: { isCurrentRaid: true },
      select: { id: true },
    });
    return {
      zones: zones.length,
      currentRaidZoneIds: kept.map((r) => r.id),
      changed: false,
    };
  }

  const prevTracked = new Set(
    (
      await db.wclZone.findMany({
        where: { isCurrentRaid: true },
        select: { id: true },
      })
    ).map((r) => r.id),
  );

  // Decide which release-set zones to TRACK. Already-tracked zones stay; a
  // NEWLY-appearing release zone is gated on having ≥1 public report (so a
  // PTR / next-release raid WCL publishes early can't be tracked before it's
  // live). If the gate can't run, the zone is simply not added THIS run.
  const trackedIds: number[] = [];
  for (const z of releaseSet) {
    if (prevTracked.has(z.id)) {
      trackedIds.push(z.id);
      continue;
    }
    let adopt = false;
    try {
      const { ZONE_REPORTS_PROBE_QUERY, zoneReportsProbeResponseSchema } =
        await import("@/server/ingestion/warcraftlogs/queries");
      const probe = await wcl.query({
        query: ZONE_REPORTS_PROBE_QUERY,
        variables: { zoneID: z.id },
        schema: zoneReportsProbeResponseSchema,
        estimatedPoints: 3,
      });
      adopt = (probe.reportData?.reports?.data ?? []).length > 0;
    } catch (err) {
      logger.warn(
        { err, zoneId: z.id },
        "worldData refresh: reports gate failed — not adding zone this run",
      );
      adopt = false;
    }
    if (adopt) trackedIds.push(z.id);
    else
      logger.warn(
        { zoneId: z.id, name: z.name },
        "worldData refresh: new release raid has no public reports yet — holding",
      );
  }

  const sortedPrev = [...prevTracked].sort((a, b) => a - b);
  const sortedNext = [...trackedIds].sort((a, b) => a - b);
  const changed =
    sortedPrev.length !== sortedNext.length ||
    sortedPrev.some((id, i) => id !== sortedNext[i]);

  // Apply the flags transactionally: exactly `trackedIds` are isCurrentRaid.
  await db.$transaction([
    db.wclZone.updateMany({
      where: { isCurrentRaid: true, NOT: { id: { in: trackedIds } } },
      data: { isCurrentRaid: false },
    }),
    db.wclZone.updateMany({
      where: { id: { in: trackedIds } },
      data: { isCurrentRaid: true },
    }),
  ]);
  if (changed) {
    try {
      await redis.del("wcl:current-raid-zone");
    } catch (err) {
      logger.warn({ err }, "worldData refresh: cache invalidation failed");
    }
    logger.info(
      { from: sortedPrev, to: sortedNext, zones: zones.length },
      "worldData refresh: tracked raid set changed",
    );
  } else {
    logger.info(
      { currentRaidZoneIds: sortedNext, zones: zones.length },
      "worldData refresh: complete",
    );
  }

  // Drift alert — the stale-pin trap this feature exists to kill: if an env
  // override is set, it FORCES a single zone and suppresses the auto-resolved
  // release set, so warn loudly (it may be stale or hiding raids).
  const pin = process.env.WCL_RAID_ZONE_ID;
  if (
    pin &&
    Number.isFinite(Number(pin)) &&
    (sortedNext.length !== 1 || sortedNext[0] !== Number(pin))
  ) {
    logger.warn(
      { envPin: Number(pin), autoResolvedRelease: sortedNext },
      "WCL_RAID_ZONE_ID env pin forces a SINGLE zone and overrides the auto-resolved release set — it may be stale or hiding current raids. Unset it (and the prod compose env) to track the full release.",
    );
  }

  return {
    zones: zones.length,
    currentRaidZoneIds: sortedNext,
    changed,
  };
}
