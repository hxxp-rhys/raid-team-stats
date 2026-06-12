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

/**
 * Discovery window. 150 days covers the whole current season (Midnight S1
 * opened 2026-03-17) — a 60-day window silently lost early-season Mythic
 * prog for guilds that farmed Heroic recently (user-reported gap).
 */
const BACKFILL_MS = 150 * 24 * 60 * 60 * 1000; // 150 days
/** Re-discovery overlap so a still-uploading log near the watermark isn't missed. */
const WATERMARK_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** A report stops changing this long after it ends — freeze it. */
const FREEZE_AFTER_MS = 48 * 60 * 60 * 1000; // 48 hours
/** Detail fetches per guild per run — caps the first-backfill burst. */
const MAX_DETAIL_FETCHES = 15;
/**
 * Below this many stored reports the watermark optimization is pointless
 * (a single full-window discovery page covers everything) and actively
 * harmful (it permanently hides reports older than the first one seen) —
 * keep discovering the whole window until the guild outgrows one page.
 */
const WATERMARK_MIN_REPORTS = 20;

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

  const [latest, storedCount] = await Promise.all([
    // revision >= 0 keeps tombstones out: a roster-gated pug report carries
    // its REAL (often recent) startTime and would otherwise advance the
    // watermark past late-uploaded guild reports.
    db.wclReport.findFirst({
      where: { guildId: guild.id, revision: { gte: 0 } },
      orderBy: { startTime: "desc" },
      select: { startTime: true },
    }),
    // Tombstoned (inaccessible) reports don't count toward outgrowing
    // full-window discovery — they carry revision -1.
    db.wclReport.count({
      where: { guildId: guild.id, revision: { gte: 0 } },
    }),
  ]);
  const startTime =
    latest && storedCount >= WATERMARK_MIN_REPORTS
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
  // A live raid-night log is typically BOTH guild-discovered and referenced
  // by member ranks — don't pay for it twice in one run.
  const fetchedThisRun = new Set<string>();
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
    fetchedThisRun.add(r.code);
    try {
      await fetchAndPersistReport(r.code, guild.id, guild.realmSlug, guild.region);
    } catch (err) {
      logger.warn(
        { err, code: r.code, guild: guild.name },
        "grs: report fetch/persist failed",
      );
    }
  }
  // Second source: reports referenced by the members' OWN parse kills.
  // Guild discovery only sees guild-TAGGED uploads — Mythic kills logged on
  // someone's personal account are invisible to it, yet their report codes
  // sit in the rankings data we already persist (week-best reportCode +
  // every per-kill ranks[] entry). Fetching those reports captures the kill
  // AND the wipes around it (user-reported gap: Mythic fights missing).
  try {
    const remaining = MAX_DETAIL_FETCHES - fetched;
    if (remaining > 0) {
      const memberCodes = await collectMemberReportCodes(guild.id);
      const knownRows = await db.wclReport.findMany({
        where: { code: { in: [...memberCodes] } },
        select: { code: true, frozen: true, endTime: true },
      });
      const knownByCode2 = new Map(knownRows.map((r) => [r.code, r]));
      let extraFetched = 0;
      for (const code of memberCodes) {
        if (fetchedThisRun.has(code)) continue;
        const existing = knownByCode2.get(code);
        if (existing?.frozen) continue;
        if (existing) {
          // Swept reports have no revision signal (they're not in the
          // guild discovery list) — time governs them instead: refetch
          // while the log could still be growing, freeze once it can't.
          if (now - existing.endTime.getTime() > FREEZE_AFTER_MS) {
            await db.wclReport.update({
              where: { code },
              data: { frozen: true },
            });
            continue;
          }
          // fall through → refetch the still-live log (cap-counted)
        }
        if (extraFetched >= remaining) {
          logger.info(
            { guild: guild.name },
            "grs: member-report cap reached — remainder next run",
          );
          break;
        }
        extraFetched++;
        try {
          await fetchAndPersistReport(
            code,
            guild.id,
            guild.realmSlug,
            guild.region,
            { minRosterMatches: 2 },
          );
        } catch (err) {
          // Permission errors arrive as GraphQL envelope errors (a throw),
          // not report:null — tombstone those too, or the code re-enters
          // the sweep every hour forever. Anything else is transient:
          // log and let the next run retry. The envelope-prefix gate is
          // load-bearing: Prisma/Postgres failures ("does not exist",
          // "permission denied" — e.g. a stale client after a migration)
          // would otherwise match the keywords and permanently tombstone
          // GENUINE reports during an ops incident.
          const msg = err instanceof Error ? err.message : String(err);
          if (
            msg.startsWith("wcl graphql errors:") &&
            /permission|private|does not exist/i.test(msg)
          ) {
            logger.info({ code, msg }, "grs: inaccessible — tombstoning");
            await db.wclReport
              .upsert({
                where: { code },
                create: {
                  code,
                  guildId: guild.id,
                  zoneId: null,
                  title: null,
                  startTime: new Date(0),
                  endTime: new Date(0),
                  revision: -1,
                  frozen: true,
                  fetchedAt: new Date(),
                },
                update: { frozen: true },
              })
              .catch(() => {});
          } else {
            logger.warn(
              { err, code, guild: guild.name },
              "grs: member report fetch/persist failed",
            );
          }
        }
      }
      fetched += extraFetched;
    }
  } catch (err) {
    logger.warn({ err, guild: guild.name }, "grs: member-report sweep failed");
  }

  if (fetched > 0) {
    logger.info(
      { guild: guild.name, discovered: found.length, fetched },
      "grs: run complete",
    );
  }
}

/**
 * Distinct WCL report codes referenced by the parse snapshots of this
 * guild's raid-team members: the week-best reportCode column plus every
 * per-kill ranks[] entry persisted in rawPayload. Bounded by an 8-week
 * recency window and one GLOBAL newest-first row cap sized at 40 ×
 * member-count (an active multi-difficulty character can crowd a quiet
 * one's older rows out of the cap — their codes surface once they next
 * sync, so the delay is bounded by activity, not lost).
 */
async function collectMemberReportCodes(guildId: string): Promise<Set<string>> {
  const members = await db.raidTeamMembership.findMany({
    where: { isActive: true, raidTeam: { guildId } },
    select: { characterId: true },
  });
  const characterIds = [...new Set(members.map((m) => m.characterId))];
  if (characterIds.length === 0) return new Set();

  const since = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000);
  const rows = await db.wclParseSnapshot.findMany({
    where: { characterId: { in: characterIds }, capturedAt: { gte: since } },
    orderBy: { capturedAt: "desc" },
    take: 40 * characterIds.length,
    select: { reportCode: true, rawPayload: true },
  });

  const codes = new Set<string>();
  for (const r of rows) {
    if (r.reportCode) codes.add(r.reportCode);
    const raw =
      typeof r.rawPayload === "object" && r.rawPayload !== null
        ? (r.rawPayload as Record<string, unknown>)
        : {};
    if (!Array.isArray(raw.ranks)) continue;
    for (const rank of raw.ranks as Array<{
      report?: { code?: unknown } | null;
    }>) {
      const code = rank?.report?.code;
      if (typeof code === "string" && code.length > 0) codes.add(code);
    }
  }
  return codes;
}

async function fetchAndPersistReport(
  code: string,
  guildId: string,
  guildRealmSlug: string,
  guildRegion: Region,
  opts?: {
    /**
     * Persist-time roster gate for member-SWEPT reports: a member's
     * season-wide ranks reference every public log they ever appeared in,
     * including pugs/community raids — ingesting those wholesale injects
     * foreign pulls (and foreign KILLS) into the team's progression view.
     * Require at least this many DISTINCT matched roster characters among
     * the report's actors; below it the report is tombstoned, never
     * persisted. Guild-DISCOVERED reports skip the gate (guild-tagged =
     * the team's own uploads).
     */
    minRosterMatches?: number;
  },
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
    // Private/deleted report (member-parse codes can reference logs we
    // can't read). Tombstone it as frozen so it never consumes a fetch
    // slot again — without this, an inaccessible code would retry every
    // hourly run forever.
    logger.warn({ code }, "grs: report inaccessible — tombstoning");
    await db.wclReport.upsert({
      where: { code },
      create: {
        code,
        guildId,
        zoneId: null,
        title: null,
        startTime: new Date(0),
        endTime: new Date(0),
        revision: -1,
        frozen: true,
        fetchedAt: new Date(),
      },
      update: { frozen: true },
    });
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
        // Active raid-team members only: matching any tracked Character
        // (alts, casuals, departed members) would let a pug containing two
        // guildies of any kind pass the roster gate.
        where: {
          region: guildRegion,
          name: { in: names },
          raidMemberships: { some: { isActive: true } },
        },
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

  if (opts?.minRosterMatches) {
    const matched = new Set(
      actors
        .map((a) => characterIdFor(a))
        .filter((id): id is string => id != null),
    ).size;
    if (matched < opts.minRosterMatches) {
      logger.info(
        { code, matched, required: opts.minRosterMatches },
        "grs: member-swept report failed the roster gate — tombstoning (foreign pug/community log)",
      );
      await db.wclReport.upsert({
        where: { code },
        create: {
          code,
          guildId,
          zoneId: report.zone?.id ?? null,
          title: null,
          startTime: new Date(report.startTime),
          endTime: new Date(report.endTime),
          revision: -1,
          frozen: true,
          fetchedAt: new Date(),
        },
        update: { frozen: true },
      });
      return;
    }
  }

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
