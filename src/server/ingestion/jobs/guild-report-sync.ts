import type { Region } from "@/generated/prisma/enums";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { normalizeRealmSlug } from "@/lib/realm";
import { queues, QUEUE_NAMES } from "@/server/ingestion/queues";
import { warcraftLogsClient } from "@/server/ingestion/warcraftlogs/client";
import {
  GUILD_ID_LOOKUP_QUERY,
  GUILD_REPORTS_QUERY,
  guildLookupResponseSchema,
  guildReportsResponseSchema,
  REPORT_DEATHS_QUERY,
  reportDeathsResponseSchema,
  REPORT_DEATHS_TABLE_QUERY,
  reportDeathsTableResponseSchema,
  REPORT_DAMAGE_TAKEN_QUERY,
  reportDamageTakenResponseSchema,
  REPORT_REZZES_QUERY,
  REZ_FILTER_EXPRESSION,
  REPORT_DEFENSIVE_BUFFS_QUERY,
  REPORT_DEFENSIVE_CASTS_QUERY,
  REPORT_FIGHTS_QUERY,
  reportFightsResponseSchema,
} from "@/server/ingestion/warcraftlogs/queries";
import {
  buildIngestDeaths,
  matchRezzesToDeaths,
  parseDeathEvents,
  parseDeathsTable,
  parseRezCasts,
  type IngestDeath,
  type ParsedDeathEvent,
  type ParsedDeathTableEntry,
  type RezTarget,
} from "@/lib/first-death-ledger";
import { parseDamageTakenTable } from "@/lib/learning-curve";
import {
  computeCooldownUsage,
  parseBuffEvents,
  parseDefensiveCasts,
  type ParsedBuffEvent,
  type ParsedDefensiveCast,
} from "@/lib/cooldown-usage";
import {
  DEFENSIVE_BUFFS_FILTER,
  DEFENSIVE_CASTS_FILTER,
} from "@/lib/defensive-cooldowns";

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
/** Deaths-layer backfills per guild per run — drains the pre-existing
 *  reports over a few hours without blowing the points budget. */
const MAX_DEATHS_BACKFILL = 8;
/** Cooldown-usage (defensive-at-death) backfills per guild per run. Each
 *  backfill updates every death row of a report, so this is kept small to
 *  bound the per-run write volume; it drains over hourly runs then stops. */
const MAX_COOLDOWNS_BACKFILL = 6;
/** learning_curve avoidable-damage enrichment bounds. Top-N killing abilities
 *  (= auto-curated avoidable mechanics), only bosses with enough wipes to
 *  split into halves, a few encounters per run — keeps WCL spend bounded. */
const AVOIDABLE_TOP_N = 3;
const MIN_AVOIDABLE_WIPES = 10;
const MAX_AVOIDABLE_ENCOUNTERS_PER_RUN = 2;
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

/**
 * Enqueue a GRS run for one guild right now — used after a team's WCL log
 * source changes so the new source's reports arrive without waiting for
 * the hourly cron (the caller clears stale data BEFORE enqueueing).
 */
export async function enqueueImmediateGuildReportSync(
  guildId: string,
): Promise<void> {
  await queues.guildReportSync.add(
    QUEUE_NAMES.guildReportSync,
    { guildId } satisfies GuildReportSyncPayload,
    { jobId: `grs-immediate_${guildId}_${Date.now()}` },
  );
}

/**
 * Resolve the guild's DEFAULT WCL source: its own WCL guild id, looked up
 * once from the Blizzard identity and cached on the Guild row. Null when
 * the guild has no WCL presence (re-attempted each run; ~2 pts).
 */
async function resolveGuildWclId(guild: {
  id: string;
  name: string;
  region: Region;
  realmSlug: string;
  wclGuildId: number | null;
}): Promise<number | null> {
  if (guild.wclGuildId != null) return guild.wclGuildId;
  try {
    const res = await warcraftLogsClient().query({
      query: GUILD_ID_LOOKUP_QUERY,
      variables: {
        name: guild.name,
        serverSlug: guild.realmSlug,
        serverRegion: guild.region.toLowerCase(),
      },
      schema: guildLookupResponseSchema,
      estimatedPoints: 2,
    });
    const id = res.guildData?.guild?.id ?? null;
    if (id != null) {
      await db.guild.update({
        where: { id: guild.id },
        data: { wclGuildId: id },
      });
      logger.info(
        { guild: guild.name, wclGuildId: id },
        "grs: resolved guild's default WCL source",
      );
    }
    return id;
  } catch (err) {
    logger.warn({ err, guild: guild.name }, "grs: WCL guild id resolution failed");
    return null;
  }
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
      wclGuildId: true,
      raidTeams: {
        where: { memberships: { some: { isActive: true } } },
        select: { wclGuildId: true },
      },
    },
  });
  if (!guild) {
    logger.warn({ guildId: payload.guildId }, "grs: guild not found");
    return;
  }

  const wcl = warcraftLogsClient();
  // Zone scoping is an optimization, not a correctness requirement. We discover
  // once per CURRENT-RELEASE raid zone (patches ADD raids to a release, so a
  // guild may log an older release raid on a separate night), deduped by report
  // code. With none resolved we discover unfiltered (window-limited).
  const zoneIds = await wcl.currentRaidZoneIds();

  // One discovery pass per distinct log SOURCE: each team's effective
  // source is its override or the guild's resolved default. Teams that log
  // under their own WCL guild (e.g. a second raid team) get their own
  // listing; identical sources are deduped so the common single-source
  // guild still costs one discovery.
  const defaultSource = await resolveGuildWclId(guild);
  const sources = [
    ...new Set(
      guild.raidTeams
        .map((t) => t.wclGuildId ?? defaultSource)
        .filter((s): s is number => s != null),
    ),
  ];
  if (sources.length === 0) {
    logger.info(
      { guild: guild.name },
      "grs: no WCL source resolvable — guild discovery skipped (member sweep still runs)",
    );
  }

  const now = Date.now();
  let fetched = 0;
  let totalDiscovered = 0;
  // A live raid-night log is typically BOTH guild-discovered and referenced
  // by member ranks — don't pay for it twice in one run.
  const fetchedThisRun = new Set<string>();

  for (const source of sources) {
    const [latest, storedCount] = await Promise.all([
      // revision >= 0 keeps tombstones out: a roster-gated pug report
      // carries its REAL (often recent) startTime and would otherwise
      // advance the watermark past late-uploaded guild reports. Watermark
      // and count are PER SOURCE — sources backfill independently.
      db.wclReport.findFirst({
        where: { guildId: guild.id, wclGuildId: source, revision: { gte: 0 } },
        orderBy: { startTime: "desc" },
        select: { startTime: true },
      }),
      db.wclReport.count({
        where: { guildId: guild.id, wclGuildId: source, revision: { gte: 0 } },
      }),
    ]);
    const startTime =
      latest && storedCount >= WATERMARK_MIN_REPORTS
        ? latest.startTime.getTime() - WATERMARK_OVERLAP_MS
        : Date.now() - BACKFILL_MS;

    // One discovery query per current-release zone (≥1; unfiltered when the
    // set is empty), deduped by report code. A report covering multiple current
    // raids is found under each zone but fetched once.
    const discoveryZones: Array<number | undefined> =
      zoneIds.length > 0 ? zoneIds : [undefined];
    const rawRows = (
      await Promise.all(
        discoveryZones.map((zid) =>
          wcl.query({
            query: GUILD_REPORTS_QUERY,
            variables: { guildID: source, zoneID: zid, startTime, limit: 25 },
            schema: guildReportsResponseSchema,
            estimatedPoints: 2,
          }),
        ),
      )
    ).flatMap((discovery, i) => {
      const rows = (discovery.reportData?.reports?.data ?? []).filter(
        (r): r is NonNullable<typeof r> => r != null,
      );
      if (rows.length === 25) {
        // Limit hit. WCL returns newest-first, so anything older than the 25th
        // report is PERMANENTLY missed once the watermark advances past it.
        // Loud, not silent; the verified `page` arg is the v2 fix.
        logger.warn(
          { guild: guild.name, source, zoneId: discoveryZones[i], startTime },
          "grs: discovery page full (25) — older reports in this window are permanently skipped",
        );
      }
      return rows;
    });
    const seenCodes = new Set<string>();
    const found = rawRows.filter((r) => {
      if (seenCodes.has(r.code)) return false;
      seenCodes.add(r.code);
      return true;
    });
    totalDiscovered += found.length;
    if (found.length === 0) continue;

    const known = await db.wclReport.findMany({
      where: { code: { in: found.map((r) => r.code) } },
      select: {
        code: true,
        revision: true,
        frozen: true,
        endTime: true,
        wclGuildId: true,
      },
    });
    const knownByCode = new Map(known.map((k) => [k.code, k]));

    // Oldest first so a capped run keeps a contiguous ingested prefix.
    for (const r of [...found].sort((a, b) => a.startTime - b.startTime)) {
      const existing = knownByCode.get(r.code);
      // Tombstones (revision < 0) do NOT honor the frozen skip here: a
      // report appearing in THIS source's own listing is by definition the
      // source's accessible report — e.g. the member sweep roster-gated a
      // future override-source's logs while the team was still tiny. The
      // -1 revision never matches a real one, so it falls through to a
      // full refetch, which un-tombstones it (persist sets frozen back to
      // false). Without this, a switched-to source has permanent holes.
      if (existing?.frozen && existing.revision >= 0) {
        // Frozen rows still need source attribution backfilled — rows from
        // before source tracking (or first found by the member sweep) are
        // otherwise stuck looking "swept" and get participation-gated in
        // every team view despite being the guild's own listed reports.
        if (existing.wclGuildId == null) {
          await db.wclReport.update({
            where: { code: r.code },
            data: { wclGuildId: source },
          });
        }
        continue;
      }
      if (existing && existing.revision === r.revision) {
        // Unchanged. Backfill the source attribution on rows that predate
        // source tracking (or arrived via the member sweep), and freeze
        // once it's old enough that WCL won't mutate it.
        const patch: { frozen?: boolean; wclGuildId?: number } = {};
        if (existing.wclGuildId == null) patch.wclGuildId = source;
        if (now - existing.endTime.getTime() > FREEZE_AFTER_MS) {
          patch.frozen = true;
        }
        if (Object.keys(patch).length > 0) {
          await db.wclReport.update({ where: { code: r.code }, data: patch });
        }
        continue;
      }
      if (fetched >= MAX_DETAIL_FETCHES) {
        logger.info(
          { guild: guild.name, source },
          "grs: detail-fetch cap reached — remainder next run",
        );
        break;
      }
      fetched++;
      fetchedThisRun.add(r.code);
      try {
        await fetchAndPersistReport(
          r.code,
          guild.id,
          guild.realmSlug,
          guild.region,
          { sourceWclGuildId: source },
        );
      } catch (err) {
        logger.warn(
          { err, code: r.code, guild: guild.name, source },
          "grs: report fetch/persist failed",
        );
      }
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
        select: { code: true, frozen: true, endTime: true, wclGuildId: true },
      });
      const knownByCode2 = new Map(knownRows.map((r) => [r.code, r]));
      let extraFetched = 0;
      for (const code of memberCodes) {
        if (fetchedThisRun.has(code)) continue;
        const existing = knownByCode2.get(code);
        // SOURCED rows belong to discovery, full stop: its revision
        // tracking refetches them, and the sweep's roster gate (which
        // counts OUR characters, not the source guild's) would otherwise
        // re-tombstone a legitimately sourced report and oscillate.
        if (existing?.wclGuildId != null) continue;
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

  // Deaths-layer backfill — populate WclFightDeath for reports ingested
  // before the deaths layer shipped (a frozen report never re-enters the
  // fetch path on its own). Bounded per run; drains over a few hourly runs.
  // Scoped to the widget's 56-day read window and to reports with at least
  // one WIPE (the prog content the widget ranks). `deathsFetchedAt: null`
  // means never-attempted, so a backfilled report — even a genuinely
  // death-free one — drops out of this set permanently (no infinite
  // re-fetch). Each backfill costs only the death calls, and the WCL client
  // refuses work over budget, so this self-limits.
  try {
    const deathWindow = new Date(now - 56 * 24 * 60 * 60 * 1000);
    const needDeaths = await db.wclReport.findMany({
      where: {
        guildId: guild.id,
        revision: { gte: 0 },
        startTime: { gte: deathWindow },
        deathsFetchedAt: null,
        fights: { some: { kill: false } },
      },
      orderBy: { startTime: "desc" },
      take: MAX_DEATHS_BACKFILL,
      select: { code: true },
    });
    let backfilled = 0;
    for (const r of needDeaths) {
      const n = await backfillReportDeaths(r.code);
      if (n != null) backfilled++;
    }
    if (backfilled > 0) {
      logger.info(
        { guild: guild.name, backfilled },
        "grs deaths: backfilled deaths layer for pre-existing reports",
      );
    }
  } catch (err) {
    logger.warn({ err, guild: guild.name }, "grs deaths: backfill sweep failed");
  }

  // Cooldown-usage backfill — populate the defensive-at-death layer for death
  // rows stored before it shipped (a frozen report's deaths never re-enter the
  // normal fetch path). Pick reports (in the 56-day window, with wipes) that
  // still have death rows lacking `cooldownsFetchedAt`; bounded per run, drains
  // over hourly runs then stops. Each backfill is best-effort and the WCL
  // client refuses work over budget, so this self-limits.
  try {
    const cdWindow = new Date(now - 56 * 24 * 60 * 60 * 1000);
    const needCooldowns = await db.wclFightDeath.findMany({
      where: {
        cooldownsFetchedAt: null,
        kill: false,
        report: {
          guildId: guild.id,
          revision: { gte: 0 },
          startTime: { gte: cdWindow },
        },
      },
      distinct: ["reportCode"],
      take: MAX_COOLDOWNS_BACKFILL,
      select: { reportCode: true },
    });
    let cdBackfilled = 0;
    for (const r of needCooldowns) {
      const n = await backfillReportCooldowns(r.reportCode);
      if (n != null) cdBackfilled++;
    }
    if (cdBackfilled > 0) {
      logger.info(
        { guild: guild.name, cdBackfilled },
        "grs cooldowns: backfilled defensive-at-death layer",
      );
    }
  } catch (err) {
    logger.warn(
      { err, guild: guild.name },
      "grs cooldowns: backfill sweep failed",
    );
  }

  // Avoidable-damage sweep — recompute the learning_curve enrichment for
  // encounters whose wipe set changed since last compute (cheap count-based
  // change detector). Bounded per run; runs AFTER the deaths backfill so the
  // killing-ability list is populated. The WCL client self-limits on budget.
  try {
    const deathWindow = new Date(now - 56 * 24 * 60 * 60 * 1000);
    const wipeCounts = await db.wclFight.groupBy({
      by: ["encounterId", "difficulty"],
      where: {
        kill: false,
        report: {
          guildId: guild.id,
          revision: { gte: 0 },
          startTime: { gte: deathWindow },
        },
      },
      _count: { _all: true },
    });
    const states = await db.wclAvoidableState.findMany({
      where: { guildId: guild.id },
      select: { encounterId: true, difficulty: true, wipeFights: true },
    });
    const stateMap = new Map(
      states.map((s) => [`${s.encounterId}|${s.difficulty}`, s.wipeFights]),
    );
    const candidates = wipeCounts
      .filter(
        (w) =>
          w._count._all >= MIN_AVOIDABLE_WIPES &&
          stateMap.get(`${w.encounterId}|${w.difficulty}`) !== w._count._all,
      )
      .sort((a, b) => b._count._all - a._count._all)
      .slice(0, MAX_AVOIDABLE_ENCOUNTERS_PER_RUN);
    let avoidableComputed = 0;
    for (const c of candidates) {
      try {
        const n = await computeAvoidableForEncounter(
          guild.id,
          c.encounterId,
          c.difficulty,
        );
        if (n != null) avoidableComputed++;
      } catch (err) {
        logger.warn(
          { err, guild: guild.name, encounterId: c.encounterId },
          "grs avoidable: encounter compute failed",
        );
      }
    }
    if (avoidableComputed > 0) {
      logger.info(
        { guild: guild.name, encounters: avoidableComputed },
        "grs avoidable: recomputed learning_curve enrichment",
      );
    }
  } catch (err) {
    logger.warn({ err, guild: guild.name }, "grs avoidable: sweep failed");
  }

  if (fetched > 0) {
    logger.info(
      {
        guild: guild.name,
        sources: sources.length,
        discovered: totalDiscovered,
        fetched,
      },
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

/** Safety cap on death-event pages per report (each page is ≤10k events). */
const MAX_DEATH_EVENT_PAGES = 15;

/**
 * Fetch + merge a report's death layer: the ordered `events(dataType:
 * Deaths)` spine (time-cursor paginated) plus the `table(dataType: Deaths)`
 * overkill/killing-ability drill-down (one best-effort call). Returns
 * order-assigned deaths ready to persist. Throws only on the events spine
 * failing — the caller treats any throw as "skip deaths, keep the fights".
 */
async function fetchReportDeaths(
  code: string,
  fightIds: number[],
): Promise<IngestDeath[]> {
  if (fightIds.length === 0) return [];
  const wcl = warcraftLogsClient();

  // Events spine — paginate via nextPageTimestamp until exhausted.
  const events: ParsedDeathEvent[] = [];
  let startTime: number | undefined;
  for (let page = 0; page < MAX_DEATH_EVENT_PAGES; page++) {
    const res = await wcl.query({
      query: REPORT_DEATHS_QUERY,
      variables: { code, fightIDs: fightIds, startTime },
      schema: reportDeathsResponseSchema,
      estimatedPoints: 5,
    });
    const ev = res.reportData?.report?.events;
    events.push(...parseDeathEvents(ev?.data));
    const next = ev?.nextPageTimestamp;
    if (next == null) break;
    startTime = next;
    if (page === MAX_DEATH_EVENT_PAGES - 1) {
      logger.warn(
        { code },
        "grs deaths: event pagination cap hit — late ride-the-wipe deaths truncated (first/early order unaffected)",
      );
    }
  }

  // Overkill / killing-ability drill-down — best effort, never fatal.
  let table: ParsedDeathTableEntry[] = [];
  try {
    const tRes = await wcl.query({
      query: REPORT_DEATHS_TABLE_QUERY,
      variables: { code, fightIDs: fightIds },
      schema: reportDeathsTableResponseSchema,
      estimatedPoints: 5,
    });
    table = parseDeathsTable(tRes.reportData?.report?.table);
  } catch (err) {
    logger.warn(
      { err, code },
      "grs deaths: table fetch failed — overkill/ability omitted this run",
    );
  }

  return buildIngestDeaths(events, table);
}

/**
 * Fetch combat-resurrection casts for a report (brez_economy), paginated like
 * the deaths events. Returns each LANDED rez with an ABSOLUTE timestamp, ready
 * for matchRezzesToDeaths. Reuses the deaths events schema (same shape).
 */
async function fetchReportRezzes(
  code: string,
  fightIds: number[],
  reportStartMs: number,
): Promise<
  Array<{
    fightId: number;
    targetActorId: number;
    absTimeMs: number;
    rezzerActorId: number | null;
    abilityGameId: number | null;
  }>
> {
  if (fightIds.length === 0) return [];
  const wcl = warcraftLogsClient();
  const out: Array<{
    fightId: number;
    targetActorId: number;
    absTimeMs: number;
    rezzerActorId: number | null;
    abilityGameId: number | null;
  }> = [];
  let startTime: number | undefined;
  for (let page = 0; page < MAX_DEATH_EVENT_PAGES; page++) {
    const res = await wcl.query({
      query: REPORT_REZZES_QUERY,
      variables: {
        code,
        fightIDs: fightIds,
        startTime,
        filter: REZ_FILTER_EXPRESSION,
      },
      schema: reportDeathsResponseSchema,
      estimatedPoints: 5,
    });
    const ev = res.reportData?.report?.events;
    for (const r of parseRezCasts(ev?.data)) {
      out.push({
        fightId: r.fightId,
        targetActorId: r.targetActorId,
        absTimeMs: reportStartMs + r.timestamp,
        rezzerActorId: r.rezzerActorId,
        abilityGameId: r.abilityGameId,
      });
    }
    const next = ev?.nextPageTimestamp;
    if (next == null) break;
    startTime = next;
  }
  return out;
}

/** A death row carrying the cooldown-usage layer fields (mutated in place). */
type CooldownDeathRow = {
  fightId: number;
  targetActorId: number;
  deathAt: Date;
  defensiveActiveGameId: number | null;
  defensiveActiveName: string | null;
  lastDefensiveCastId: number | null;
  lastDefensiveCastMsBefore: number | null;
  cooldownsFetchedAt: Date | null;
};

/**
 * Fetch the personal-defensive BUFF and CAST events for a report (cooldown_usage
 * layer), both filtered to the defensive allowlist and paginated like the
 * deaths events. Timestamps stay report-relative (the compute basis). One
 * Buffs call + one Casts call across all the passed fight ids — ~10 pts total,
 * the same order as the deaths layer.
 */
/** Paginate one filtered events query (Buffs or Casts) to a flat raw array. */
async function fetchDefensiveEventPages(
  code: string,
  fightIds: number[],
  query: string,
  filter: string,
): Promise<unknown[]> {
  const wcl = warcraftLogsClient();
  const out: unknown[] = [];
  let startTime: number | undefined;
  for (let page = 0; page < MAX_DEATH_EVENT_PAGES; page++) {
    const res = await wcl.query({
      query,
      variables: { code, fightIDs: fightIds, startTime, filter },
      schema: reportDeathsResponseSchema,
      estimatedPoints: 5,
    });
    const ev = res.reportData?.report?.events;
    if (Array.isArray(ev?.data)) out.push(...ev.data);
    const next = ev?.nextPageTimestamp;
    if (next == null) break;
    startTime = next;
  }
  return out;
}

async function fetchReportDefensives(
  code: string,
  fightIds: number[],
): Promise<{ buffs: ParsedBuffEvent[]; casts: ParsedDefensiveCast[] }> {
  if (fightIds.length === 0) return { buffs: [], casts: [] };
  const buffRaw = await fetchDefensiveEventPages(
    code,
    fightIds,
    REPORT_DEFENSIVE_BUFFS_QUERY,
    DEFENSIVE_BUFFS_FILTER,
  );
  const castRaw = await fetchDefensiveEventPages(
    code,
    fightIds,
    REPORT_DEFENSIVE_CASTS_QUERY,
    DEFENSIVE_CASTS_FILTER,
  );
  return {
    buffs: parseBuffEvents(buffRaw),
    casts: parseDefensiveCasts(castRaw),
  };
}

/**
 * Compute + stamp the cooldown-usage layer onto a set of in-memory death rows
 * (mutates them in place). Best-effort: a defensive-fetch failure leaves the
 * rows' cooldown fields null + `cooldownsFetchedAt` null, so the backfill sweep
 * retries them later — it never blocks the deaths/rezzes persist. Returns true
 * when computed.
 */
async function applyCooldownUsage(
  code: string,
  deathRows: CooldownDeathRow[],
  reportStartMs: number,
): Promise<boolean> {
  const fightIds = [...new Set(deathRows.map((d) => d.fightId))];
  if (fightIds.length === 0) return true;
  let defensives: { buffs: ParsedBuffEvent[]; casts: ParsedDefensiveCast[] };
  try {
    defensives = await fetchReportDefensives(code, fightIds);
  } catch (err) {
    logger.warn({ err, code }, "grs cooldowns: defensive fetch failed");
    return false;
  }
  const results = computeCooldownUsage(
    deathRows.map((d) => ({
      fightId: d.fightId,
      targetActorId: d.targetActorId,
      relMs: d.deathAt.getTime() - reportStartMs,
    })),
    defensives.buffs,
    defensives.casts,
  );
  const now = new Date();
  for (let i = 0; i < deathRows.length; i++) {
    const r = results[i]!;
    deathRows[i]!.defensiveActiveGameId = r.defensiveActiveGameId;
    deathRows[i]!.defensiveActiveName = r.defensiveActiveName;
    deathRows[i]!.lastDefensiveCastId = r.lastDefensiveCastId;
    deathRows[i]!.lastDefensiveCastMsBefore = r.lastDefensiveCastMsBefore;
    deathRows[i]!.cooldownsFetchedAt = now;
  }
  return true;
}

/**
 * Backfill the cooldown-usage layer for an ALREADY-stored report's death rows
 * (deaths persisted before the cooldown layer shipped). Updates each existing
 * WclFightDeath row in place. Returns the number of rows stamped (or null on
 * no deaths / fetch failure). One defensive fetch + a per-row update batch.
 */
export async function backfillReportCooldowns(
  code: string,
): Promise<number | null> {
  const report = await db.wclReport.findUnique({
    where: { code },
    select: { startTime: true },
  });
  if (!report) return null;
  const deaths = await db.wclFightDeath.findMany({
    where: { reportCode: code },
    select: { id: true, fightId: true, targetActorId: true, deathAt: true },
  });
  if (deaths.length === 0) return null;
  const reportStartMs = report.startTime.getTime();
  const fightIds = [...new Set(deaths.map((d) => d.fightId))];

  let defensives: { buffs: ParsedBuffEvent[]; casts: ParsedDefensiveCast[] };
  try {
    defensives = await fetchReportDefensives(code, fightIds);
  } catch (err) {
    logger.warn({ err, code }, "grs cooldowns: backfill fetch failed");
    return null;
  }
  const results = computeCooldownUsage(
    deaths.map((d) => ({
      fightId: d.fightId,
      targetActorId: d.targetActorId,
      relMs: d.deathAt.getTime() - reportStartMs,
    })),
    defensives.buffs,
    defensives.casts,
  );
  const now = new Date();
  await db.$transaction(
    deaths.map((d, i) =>
      db.wclFightDeath.update({
        where: { id: d.id },
        data: {
          defensiveActiveGameId: results[i]!.defensiveActiveGameId,
          defensiveActiveName: results[i]!.defensiveActiveName,
          lastDefensiveCastId: results[i]!.lastDefensiveCastId,
          lastDefensiveCastMsBefore: results[i]!.lastDefensiveCastMsBefore,
          cooldownsFetchedAt: now,
        },
      }),
    ),
  );
  return deaths.length;
}

/**
 * Backfill the deaths layer for an ALREADY-stored report without re-fetching
 * its fights — used to populate WclFightDeath for reports ingested before the
 * deaths layer shipped (existing logs never re-enter the normal fetch path
 * once frozen). Reuses the report's stored fights + resolved actor→character
 * joins, so it costs only the death calls. Returns the number of deaths
 * written (or null when the report has no stored fights / fetch failed).
 */
export async function backfillReportDeaths(
  code: string,
): Promise<number | null> {
  const report = await db.wclReport.findUnique({
    where: { code },
    select: { code: true, startTime: true },
  });
  if (!report) return null;
  const [fights, actors] = await Promise.all([
    db.wclFight.findMany({
      where: { reportCode: code },
      select: {
        fightId: true,
        encounterId: true,
        difficulty: true,
        kill: true,
      },
    }),
    db.wclReportActor.findMany({
      where: { reportCode: code },
      select: { actorId: true, characterId: true },
    }),
  ]);
  if (fights.length === 0) return null;
  const reportStartMs = report.startTime.getTime();
  const fightById = new Map(fights.map((f) => [f.fightId, f]));
  const actorToCharacter = new Map(
    actors.map((a) => [a.actorId, a.characterId]),
  );

  let ingestDeaths: IngestDeath[];
  try {
    ingestDeaths = await fetchReportDeaths(
      code,
      fights.map((f) => f.fightId),
    );
  } catch (err) {
    logger.warn({ err, code }, "grs deaths: backfill fetch failed");
    return null;
  }

  const rows = ingestDeaths
    .filter((d) => fightById.has(d.fightId))
    .map((d) => {
      const meta = fightById.get(d.fightId)!;
      return {
        reportCode: code,
        fightId: d.fightId,
        encounterId: meta.encounterId,
        difficulty: meta.difficulty,
        kill: meta.kill,
        targetActorId: d.targetActorId,
        characterId: actorToCharacter.get(d.targetActorId) ?? null,
        killerActorId: d.killerActorId,
        killingAbilityGameId: d.killingAbilityGameId,
        killingAbilityName: d.killingAbilityName,
        deathAt: new Date(reportStartMs + d.timestamp),
        deathOrder: d.deathOrder,
        overkill:
          d.overkill != null ? BigInt(Math.max(0, Math.round(d.overkill))) : null,
        rezzedAt: null as Date | null,
        rezzerActorId: null as number | null,
        rezAbilityGameId: null as number | null,
        defensiveActiveGameId: null as number | null,
        defensiveActiveName: null as string | null,
        lastDefensiveCastId: null as number | null,
        lastDefensiveCastMsBefore: null as number | null,
        cooldownsFetchedAt: null as Date | null,
      };
    });

  // Battle-rez economy: stamp deaths a combat-rez brought back (best-effort).
  try {
    const rezzes = await fetchReportRezzes(
      code,
      fights.map((f) => f.fightId),
      reportStartMs,
    );
    if (rezzes.length > 0) {
      const targets: RezTarget[] = rows.map((d) => ({
        fightId: d.fightId,
        targetActorId: d.targetActorId,
        deathAtMs: d.deathAt.getTime(),
        rezzedAtMs: null,
        rezzerActorId: null,
        rezAbilityGameId: null,
      }));
      matchRezzesToDeaths(targets, rezzes);
      for (let i = 0; i < rows.length; i++) {
        const t = targets[i]!;
        if (t.rezzedAtMs != null) {
          rows[i]!.rezzedAt = new Date(t.rezzedAtMs);
          rows[i]!.rezzerActorId = t.rezzerActorId;
          rows[i]!.rezAbilityGameId = t.rezAbilityGameId;
        }
      }
    }
  } catch (err) {
    logger.warn({ err, code }, "grs brez: backfill rez fetch failed");
  }

  // Cooldown-usage layer — stamp each row with defensive-at-death (best-effort;
  // leaves cooldownsFetchedAt null on failure so the cooldown sweep retries).
  await applyCooldownUsage(code, rows, reportStartMs);

  await db.$transaction([
    db.wclFightDeath.deleteMany({ where: { reportCode: code } }),
    db.wclFightDeath.createMany({ data: rows, skipDuplicates: true }),
    // Mark the deaths attempt (even at 0 rows) so the sweep won't re-fetch a
    // genuinely death-free report every run.
    db.wclReport.update({
      where: { code },
      data: { deathsFetchedAt: new Date() },
    }),
  ]);
  return rows.length;
}

/**
 * Compute the avoidable-damage enrichment for one (guild, encounter,
 * difficulty): per-player damage taken from the boss's top killing abilities
 * (auto-curated avoidable mechanics), split into an early/late wipe half.
 * Persisted wholesale to WclAvoidableDamage + a WclAvoidableState stamp. Each
 * DamageTaken call is best-effort; the WCL client refuses work over budget.
 */
export async function computeAvoidableForEncounter(
  guildId: string,
  encounterId: number,
  difficulty: number,
): Promise<number | null> {
  const since = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000);
  const wipes = await db.wclFight.findMany({
    where: {
      encounterId,
      difficulty,
      kill: false,
      report: { guildId, revision: { gte: 0 }, startTime: { gte: since } },
    },
    select: { reportCode: true, fightId: true },
    orderBy: { startAt: "asc" },
  });
  if (wipes.length < MIN_AVOIDABLE_WIPES) return null;
  const half = Math.floor(wipes.length / 2);
  const buckets = [
    { bucket: 0, fights: wipes.slice(0, half) },
    { bucket: 1, fights: wipes.slice(wipes.length - half) },
  ];

  // Top-N killing abilities = the avoidable mechanics (no hand-curation).
  const topAbilities = await db.wclFightDeath.groupBy({
    by: ["killingAbilityGameId"],
    where: {
      encounterId,
      difficulty,
      kill: false,
      killingAbilityGameId: { not: null },
      report: { guildId },
    },
    _count: { _all: true },
    orderBy: { _count: { killingAbilityGameId: "desc" } },
    take: AVOIDABLE_TOP_N,
  });
  const abilities = topAbilities
    .map((a) => a.killingAbilityGameId)
    .filter((a): a is number => a != null);

  // Actor→character maps per involved report (DamageTaken entries are by
  // report-local actor id; keep only those resolving to a tracked character).
  const involvedCodes = [...new Set(wipes.map((f) => f.reportCode))];
  const actors = await db.wclReportActor.findMany({
    where: { reportCode: { in: involvedCodes } },
    select: { reportCode: true, actorId: true, characterId: true },
  });
  const actorMap = new Map<string, Map<number, string>>();
  for (const a of actors) {
    if (!a.characterId) continue;
    (actorMap.get(a.reportCode) ??
      actorMap.set(a.reportCode, new Map()).get(a.reportCode)!).set(
      a.actorId,
      a.characterId,
    );
  }

  const wcl = warcraftLogsClient();
  const totals = new Map<string, bigint>(); // `${bucket}|${ability}|${cid}` → total
  for (const { bucket, fights } of buckets) {
    const byReport = new Map<string, number[]>();
    for (const f of fights) {
      (byReport.get(f.reportCode) ??
        byReport.set(f.reportCode, []).get(f.reportCode)!).push(f.fightId);
    }
    for (const [code, fids] of byReport) {
      const amap = actorMap.get(code);
      if (!amap) continue;
      for (const ability of abilities) {
        try {
          const res = await wcl.query({
            query: REPORT_DAMAGE_TAKEN_QUERY,
            variables: { code, fightIDs: fids, abilityID: ability },
            schema: reportDamageTakenResponseSchema,
            estimatedPoints: 4,
          });
          for (const e of parseDamageTakenTable(res.reportData?.report?.table)) {
            const cid = amap.get(e.actorId);
            if (!cid) continue;
            const key = `${bucket}|${ability}|${cid}`;
            totals.set(
              key,
              (totals.get(key) ?? BigInt(0)) +
                BigInt(Math.max(0, Math.round(e.total))),
            );
          }
        } catch (err) {
          logger.warn(
            { err, code, ability },
            "grs avoidable: DamageTaken fetch failed",
          );
        }
      }
    }
  }

  const rows = [...totals.entries()].map(([k, total]) => {
    const [bucket, ability, cid] = k.split("|");
    return {
      guildId,
      encounterId,
      difficulty,
      bucket: Number(bucket),
      abilityGameId: Number(ability),
      characterId: cid!,
      total,
    };
  });
  await db.$transaction([
    db.wclAvoidableDamage.deleteMany({
      where: { guildId, encounterId, difficulty },
    }),
    db.wclAvoidableDamage.createMany({ data: rows, skipDuplicates: true }),
    db.wclAvoidableState.upsert({
      where: {
        guildId_encounterId_difficulty: { guildId, encounterId, difficulty },
      },
      create: {
        guildId,
        encounterId,
        difficulty,
        computedAt: new Date(),
        wipeFights: wipes.length,
      },
      update: { computedAt: new Date(), wipeFights: wipes.length },
    }),
  ]);
  return rows.length;
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
    /**
     * The WCL guild id this report was discovered under (the log source).
     * Omitted on the member sweep — those rows keep wclGuildId null and
     * are attributed to teams by roster participation at read time. Never
     * overwrites an existing source with null.
     */
    sourceWclGuildId?: number;
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
          wclGuildId: opts?.sourceWclGuildId ?? null,
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

  // Deaths layer — best-effort enrichment, fetched AFTER fights are known
  // (we need the fight ids). Two invariants: a failure must never drop the
  // fights, and it must never WIPE previously-ingested deaths — so the death
  // writes only join the transaction when THIS run actually fetched them.
  const fightById = new Map(
    fights.map((f) => [
      f.id,
      {
        encounterId: f.encounterID,
        difficulty: f.difficulty ?? 0,
        kill: f.kill === true,
      },
    ]),
  );
  const actorById = new Map(actors.map((a) => [a.id, a]));
  let deathRows: Array<{
    reportCode: string;
    fightId: number;
    encounterId: number;
    difficulty: number;
    kill: boolean;
    targetActorId: number;
    characterId: string | null;
    killerActorId: number | null;
    killingAbilityGameId: number | null;
    killingAbilityName: string | null;
    deathAt: Date;
    deathOrder: number;
    overkill: bigint | null;
    rezzedAt: Date | null;
    rezzerActorId: number | null;
    rezAbilityGameId: number | null;
    defensiveActiveGameId: number | null;
    defensiveActiveName: string | null;
    lastDefensiveCastId: number | null;
    lastDefensiveCastMsBefore: number | null;
    cooldownsFetchedAt: Date | null;
  }> = [];
  let deathsFetched = false;
  try {
    const ingestDeaths = await fetchReportDeaths(
      report.code,
      fights.map((f) => f.id),
    );
    deathRows = ingestDeaths
      .filter((d) => fightById.has(d.fightId))
      .map((d) => {
        const meta = fightById.get(d.fightId)!;
        const actor = actorById.get(d.targetActorId);
        return {
          reportCode: report.code,
          fightId: d.fightId,
          encounterId: meta.encounterId,
          difficulty: meta.difficulty,
          kill: meta.kill,
          targetActorId: d.targetActorId,
          characterId: actor ? characterIdFor(actor) : null,
          killerActorId: d.killerActorId,
          killingAbilityGameId: d.killingAbilityGameId,
          killingAbilityName: d.killingAbilityName,
          deathAt: new Date(reportStartMs + d.timestamp),
          deathOrder: d.deathOrder,
          overkill:
            d.overkill != null
              ? BigInt(Math.max(0, Math.round(d.overkill)))
              : null,
          rezzedAt: null as Date | null,
          rezzerActorId: null as number | null,
          rezAbilityGameId: null as number | null,
          defensiveActiveGameId: null as number | null,
          defensiveActiveName: null as string | null,
          lastDefensiveCastId: null as number | null,
          lastDefensiveCastMsBefore: null as number | null,
          cooldownsFetchedAt: null as Date | null,
        };
      });
    // Battle-rez economy: stamp each death that a combat-rez brought back.
    try {
      const rezzes = await fetchReportRezzes(
        report.code,
        fights.map((f) => f.id),
        reportStartMs,
      );
      if (rezzes.length > 0) {
        const targets: RezTarget[] = deathRows.map((d) => ({
          fightId: d.fightId,
          targetActorId: d.targetActorId,
          deathAtMs: d.deathAt.getTime(),
          rezzedAtMs: null,
          rezzerActorId: null,
          rezAbilityGameId: null,
        }));
        matchRezzesToDeaths(targets, rezzes);
        for (let i = 0; i < deathRows.length; i++) {
          const t = targets[i]!;
          if (t.rezzedAtMs != null) {
            deathRows[i]!.rezzedAt = new Date(t.rezzedAtMs);
            deathRows[i]!.rezzerActorId = t.rezzerActorId;
            deathRows[i]!.rezAbilityGameId = t.rezAbilityGameId;
          }
        }
      }
    } catch (err) {
      logger.warn(
        { err, code: report.code },
        "grs brez: rez fetch failed — deaths persisted without rez data",
      );
    }
    // Cooldown-usage layer — defensive-at-death + last defensive cast. Stamps
    // the rows in place (best-effort; a failure leaves cooldownsFetchedAt null
    // so the cooldown sweep retries without blocking the deaths persist).
    await applyCooldownUsage(report.code, deathRows, reportStartMs);
    deathsFetched = true;
  } catch (err) {
    logger.warn(
      { err, code: report.code },
      "grs deaths: layer fetch failed — fights persisted, existing deaths preserved",
    );
  }

  const fetchedAt = new Date();
  await db.$transaction([
    db.wclReport.upsert({
      where: { code: report.code },
      create: {
        code: report.code,
        guildId,
        zoneId: report.zone?.id ?? null,
        wclGuildId: opts?.sourceWclGuildId ?? null,
        title: null,
        startTime: new Date(report.startTime),
        endTime: new Date(report.endTime),
        revision: report.revision,
        fetchedAt,
        ...(deathsFetched ? { deathsFetchedAt: fetchedAt } : {}),
      },
      update: {
        zoneId: report.zone?.id ?? null,
        startTime: new Date(report.startTime),
        endTime: new Date(report.endTime),
        revision: report.revision,
        fetchedAt,
        // A successful full persist always yields a LIVE row — this is what
        // un-tombstones a previously inaccessible/roster-gated report when
        // sourced discovery later proves it belongs to the team's source
        // (the freeze rules re-apply on later runs as usual).
        frozen: false,
        // Source only ever set/upgraded, never cleared: a member-sweep
        // refetch (no source) must not erase discovery's attribution.
        ...(opts?.sourceWclGuildId != null
          ? { wclGuildId: opts.sourceWclGuildId }
          : {}),
        // Stamp the deaths attempt only when this run fetched them; a failed
        // deaths fetch must not mark the report as attempted (so the sweep
        // still retries it), and must not clear a prior stamp.
        ...(deathsFetched ? { deathsFetchedAt: fetchedAt } : {}),
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
    // Deaths replaced wholesale like fights — but ONLY when this run fetched
    // them, so a transient deaths failure never erases a good prior ingest.
    ...(deathsFetched
      ? [
          db.wclFightDeath.deleteMany({ where: { reportCode: report.code } }),
          // skipDuplicates guards the (rare) same-actor-same-ms double death,
          // which would otherwise P2002-abort the whole report transaction.
          db.wclFightDeath.createMany({ data: deathRows, skipDuplicates: true }),
        ]
      : []),
  ]);
}
