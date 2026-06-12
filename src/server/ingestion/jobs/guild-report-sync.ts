import type { Region } from "@/generated/prisma/enums";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { normalizeRealmSlug } from "@/lib/realm";
import { queues, QUEUE_NAMES } from "@/server/ingestion/queues";
import { warcraftLogsClient } from "@/server/ingestion/warcraftlogs/client";
import {
  GUILD_REPORTS_QUERY,
  guildReportsResponseSchema,
  REPORT_FIGHTS_QUERY,
  reportFightsResponseSchema,
} from "@/server/ingestion/warcraftlogs/queries";

/**
 * Guild Report Sync (GRS) — hourly per-guild ingestion of public WCL
 * combat-log reports into WclReport / WclFight / WclReportActor.
 *
 * Budget shape: discovery is ~2 pts per guild per hour; each new/changed
 * report costs ~8 pts once and is then re-fetched only while its `revision`
 * keeps changing (live logging) or until 48h after it ends, after which it
 * is frozen forever. Idle hours therefore cost ~2 pts/guild against the
 * hourly points budget the WCL client already enforces.
 *
 * Coverage rules (per the research spec):
 *  - The report's OWN zone id is stored — never a hard-coded encounter
 *    list — so a mid-season raid addition keeps working unchanged.
 *  - M+ fights (keystoneLevel != null) and trash (encounterID 0) are
 *    dropped at ingest; everything else is kept.
 *  - Actor→Character joins are best-effort by (name, normalized server);
 *    unmatched actors persist with characterId null, never dropped.
 */

export type GuildReportSyncPayload = { guildId: string };

const hourKey = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}-${d.getUTCHours()}`;
};

/** Initial discovery window for a guild with no stored reports. */
const BACKFILL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
/** Re-discovery overlap so a still-uploading log near the watermark isn't missed. */
const WATERMARK_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** A report stops changing this long after it ends — freeze it. */
const FREEZE_AFTER_MS = 48 * 60 * 60 * 1000; // 48 hours
/** Detail fetches per guild per run — caps the first-backfill burst. */
const MAX_DETAIL_FETCHES = 15;

/** Enqueue one GRS job per guild that has at least one active raid team. */
export async function enqueueGuildReportSyncForAll(): Promise<{
  enqueued: number;
}> {
  const guilds = await db.guild.findMany({
    where: {
      raidTeams: { some: { memberships: { some: { isActive: true } } } },
    },
    select: { id: true },
  });
  if (guilds.length === 0) return { enqueued: 0 };
  await queues.guildReportSync.addBulk(
    guilds.map((g) => ({
      name: QUEUE_NAMES.guildReportSync,
      data: { guildId: g.id } satisfies GuildReportSyncPayload,
      opts: { jobId: `grs_${g.id}_${hourKey()}` },
    })),
  );
  return { enqueued: guilds.length };
}

export async function handleGuildReportSync(
  payload: GuildReportSyncPayload,
): Promise<void> {
  const guild = await db.guild.findUnique({
    where: { id: payload.guildId },
    select: {
      id: true,
      name: true,
      region: true,
      realmSlug: true,
    },
  });
  if (!guild) {
    logger.warn({ guildId: payload.guildId }, "grs: guild not found");
    return;
  }

  const wcl = warcraftLogsClient();
  // Zone scoping is an optimization, not a correctness requirement — when
  // resolution fails we discover without a zone filter (window-limited).
  const zoneId = await wcl.currentRaidZoneId();

  const latest = await db.wclReport.findFirst({
    where: { guildId: guild.id },
    orderBy: { startTime: "desc" },
    select: { startTime: true },
  });
  const startTime = latest
    ? latest.startTime.getTime() - WATERMARK_OVERLAP_MS
    : Date.now() - BACKFILL_MS;

  const discovery = await wcl.query({
    query: GUILD_REPORTS_QUERY,
    variables: {
      guildName: guild.name,
      guildServerSlug: guild.realmSlug,
      guildServerRegion: guild.region.toLowerCase(),
      zoneID: zoneId ?? undefined,
      startTime,
      limit: 25,
    },
    schema: guildReportsResponseSchema,
    estimatedPoints: 2,
  });

  const found = (discovery.reportData?.reports?.data ?? []).filter(
    (r): r is NonNullable<typeof r> => r != null,
  );
  if (found.length === 25) {
    // Limit hit. WCL returns newest-first, so anything older than the 25th
    // report is PERMANENTLY missed once the watermark advances past it —
    // this mostly bites the first 60d backfill of a long-logging guild.
    // Loud, not silent; the verified `page` arg is the v2 fix if it matters.
    logger.warn(
      { guild: guild.name, startTime },
      "grs: discovery page full (25) — older reports in this window are permanently skipped",
    );
  }
  if (found.length === 0) return;

  const known = await db.wclReport.findMany({
    where: { code: { in: found.map((r) => r.code) } },
    select: { code: true, revision: true, frozen: true, endTime: true },
  });
  const knownByCode = new Map(known.map((k) => [k.code, k]));

  const now = Date.now();
  let fetched = 0;
  // Oldest first so a capped run keeps a contiguous ingested prefix.
  for (const r of [...found].sort((a, b) => a.startTime - b.startTime)) {
    const existing = knownByCode.get(r.code);
    if (existing?.frozen) continue;
    if (existing && existing.revision === r.revision) {
      // Unchanged. Freeze once it's old enough that WCL won't mutate it.
      if (now - existing.endTime.getTime() > FREEZE_AFTER_MS) {
        await db.wclReport.update({
          where: { code: r.code },
          data: { frozen: true },
        });
      }
      continue;
    }
    if (fetched >= MAX_DETAIL_FETCHES) {
      logger.info(
        { guild: guild.name },
        "grs: detail-fetch cap reached — remainder next run",
      );
      break;
    }
    fetched++;
    try {
      await fetchAndPersistReport(r.code, guild.id, guild.realmSlug, guild.region);
    } catch (err) {
      logger.warn(
        { err, code: r.code, guild: guild.name },
        "grs: report fetch/persist failed",
      );
    }
  }
  if (fetched > 0) {
    logger.info(
      { guild: guild.name, discovered: found.length, fetched },
      "grs: run complete",
    );
  }
}

async function fetchAndPersistReport(
  code: string,
  guildId: string,
  guildRealmSlug: string,
  guildRegion: Region,
): Promise<void> {
  const wcl = warcraftLogsClient();
  const res = await wcl.query({
    query: REPORT_FIGHTS_QUERY,
    variables: { code },
    schema: reportFightsResponseSchema,
    estimatedPoints: 8,
  });
  const report = res.reportData?.report;
  if (!report) {
    logger.warn({ code }, "grs: report detail came back empty");
    return;
  }

  const reportStartMs = report.startTime;
  const fights = (report.fights ?? [])
    .filter((f): f is NonNullable<typeof f> => f != null)
    // Raid pulls only: M+ fights carry keystoneLevel; encounterID 0 = trash.
    .filter((f) => f.keystoneLevel == null && f.encounterID > 0);

  const actors = (report.masterData?.actors ?? []).filter(
    (a): a is NonNullable<typeof a> => a != null,
  );

  // Best-effort actor→Character join: name match within the guild's region,
  // then server check against the normalized realm slug. A null actor
  // server means "same server as the report's guild".
  const names = [...new Set(actors.map((a) => a.name))];
  const candidates = names.length
    ? await db.character.findMany({
        where: { region: guildRegion, name: { in: names } },
        select: { id: true, name: true, realmSlug: true },
      })
    : [];
  const characterIdFor = (a: { name: string; server?: string | null }) => {
    const serverSlug = a.server
      ? normalizeRealmSlug(a.server)
      : guildRealmSlug;
    return (
      candidates.find(
        (c) => c.name === a.name && c.realmSlug === serverSlug,
      )?.id ?? null
    );
  };

  const fetchedAt = new Date();
  await db.$transaction([
    db.wclReport.upsert({
      where: { code: report.code },
      create: {
        code: report.code,
        guildId,
        zoneId: report.zone?.id ?? null,
        title: null,
        startTime: new Date(report.startTime),
        endTime: new Date(report.endTime),
        revision: report.revision,
        fetchedAt,
      },
      update: {
        zoneId: report.zone?.id ?? null,
        startTime: new Date(report.startTime),
        endTime: new Date(report.endTime),
        revision: report.revision,
        fetchedAt,
      },
    }),
    // Live logs grow and pulls can be re-cut — replace wholesale.
    db.wclFight.deleteMany({ where: { reportCode: report.code } }),
    db.wclFight.createMany({
      data: fights.map((f) => ({
        reportCode: report.code,
        fightId: f.id,
        encounterId: f.encounterID,
        difficulty: f.difficulty ?? 0,
        kill: f.kill === true,
        size: f.size ?? null,
        bossPct: f.bossPercentage ?? null,
        fightPct: f.fightPercentage ?? null,
        lastPhase: f.lastPhase ?? null,
        lastPhaseIsIntermission: f.lastPhaseIsIntermission ?? null,
        startAt: new Date(reportStartMs + f.startTime),
        endAt: new Date(reportStartMs + f.endTime),
        durationMs: Math.max(0, Math.round(f.endTime - f.startTime)),
        friendlyPlayerIds: (f.friendlyPlayers ?? []).filter(
          (id): id is number => id != null,
        ),
      })),
    }),
    db.wclReportActor.deleteMany({ where: { reportCode: report.code } }),
    db.wclReportActor.createMany({
      data: actors.map((a) => ({
        reportCode: report.code,
        actorId: a.id,
        name: a.name,
        server: a.server ?? null,
        subType: a.subType ?? null,
        characterId: characterIdFor(a),
      })),
    }),
  ]);
}
