/**
 * Series materializer. Turns an active RaidEventSeries into concrete RaidEvent
 * rows for a rolling horizon. Idempotent and race-safe: it only CREATES the
 * occurrences that don't exist yet, keyed by the (seriesId, occurrenceDate)
 * unique constraint — two workers (or a worker + a request-time call) racing on
 * the same date just have one win and the other skip on the constraint.
 *
 * The materializer never updates or deletes; propagating a series EDIT to its
 * existing occurrences is `reconcileSeries` (applied in the calendar router).
 * Here we only fill the horizon forward.
 */

import type { ExtendedPrismaClient } from "@/lib/db";
import { logger } from "@/lib/logger";
import { enumerateOccurrences, type SeriesSpec } from "@/lib/calendar/occurrence";
import { appendOutbox, serverActionKey } from "@/server/calendar/sync";

/** How far ahead we keep occurrences materialized. */
export const MATERIALIZE_HORIZON_DAYS = 56;

type SeriesRow = {
  id: string;
  raidTeamId: string;
  title: string;
  difficulty: string;
  byday: string[];
  startLocal: string;
  durationMin: number;
  timezone: string;
  raidSize: number | null;
  notes: string | null;
  startsOn: Date | null;
  endsOn: Date | null;
  isActive: boolean;
  createdByUserId: string | null;
};

const SERIES_SELECT = {
  id: true,
  raidTeamId: true,
  title: true,
  difficulty: true,
  byday: true,
  startLocal: true,
  durationMin: true,
  timezone: true,
  raidSize: true,
  notes: true,
  startsOn: true,
  endsOn: true,
  isActive: true,
  createdByUserId: true,
} as const;

export function seriesSpec(s: SeriesRow): SeriesSpec {
  return {
    byday: s.byday,
    startLocal: s.startLocal,
    timezone: s.timezone,
    startsOn: s.startsOn,
    endsOn: s.endsOn,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

/**
 * Materialize one series forward over `horizonDays`. Returns how many new
 * occurrences were created. A no-op for an inactive/missing series.
 */
export async function materializeSeries(
  db: ExtendedPrismaClient,
  seriesId: string,
  opts?: { horizonDays?: number; now?: Date },
): Promise<{ created: number }> {
  const s = await db.raidEventSeries.findUnique({
    where: { id: seriesId },
    select: SERIES_SELECT,
  });
  if (!s || !s.isActive) return { created: 0 };

  const now = opts?.now ?? new Date();
  const horizonDays = opts?.horizonDays ?? MATERIALIZE_HORIZON_DAYS;
  const to = new Date(now.getTime() + horizonDays * 86_400_000);

  let occurrences;
  try {
    occurrences = enumerateOccurrences(seriesSpec(s), now, to);
  } catch (err) {
    logger.warn({ err, seriesId }, "materialize: enumerate failed (bad spec)");
    return { created: 0 };
  }
  if (occurrences.length === 0) return { created: 0 };

  // Dates already present for this series (ANY status — they own the unique slot).
  const existing = await db.raidEvent.findMany({
    where: { seriesId: s.id, occurrenceDate: { in: occurrences.map((o) => o.occurrenceDate) } },
    select: { occurrenceDate: true },
  });
  const have = new Set(existing.map((e) => e.occurrenceDate));
  const missing = occurrences.filter((o) => !have.has(o.occurrenceDate));

  let created = 0;
  for (const o of missing) {
    try {
      await db.$transaction(async (tx) => {
        const e = await tx.raidEvent.create({
          data: {
            raidTeamId: s.raidTeamId,
            seriesId: s.id,
            title: s.title,
            difficulty: s.difficulty,
            raidSize: s.raidSize,
            startsAt: o.startsAt,
            durationMin: s.durationMin,
            timezone: o.timezone,
            localTime: o.localTime,
            occurrenceDate: o.occurrenceDate,
            notes: s.notes,
            createdByUserId: s.createdByUserId,
          },
          select: { id: true, version: true },
        });
        await appendOutbox(tx, {
          raidTeamId: s.raidTeamId,
          raidEventId: e.id,
          kind: "event.created",
          payload: { eventId: e.id, seriesId: s.id, materialized: true },
          version: e.version,
          idempotencyKey: serverActionKey(),
        });
      });
      created++;
    } catch (err) {
      if (isUniqueViolation(err)) continue; // concurrent sweep won the slot — fine
      logger.warn(
        { err, seriesId: s.id, occurrenceDate: o.occurrenceDate },
        "materialize: occurrence create failed",
      );
    }
  }
  return { created };
}

/** Materialize every active series. Used by the worker's periodic sweep. */
export async function materializeAllActiveSeries(
  db: ExtendedPrismaClient,
  opts?: { horizonDays?: number; now?: Date },
): Promise<{ series: number; created: number }> {
  const ids = await db.raidEventSeries.findMany({
    where: { isActive: true },
    select: { id: true },
  });
  let created = 0;
  for (const { id } of ids) {
    try {
      created += (await materializeSeries(db, id, opts)).created;
    } catch (err) {
      logger.warn({ err, seriesId: id }, "materialize: series failed");
    }
  }
  return { series: ids.length, created };
}
