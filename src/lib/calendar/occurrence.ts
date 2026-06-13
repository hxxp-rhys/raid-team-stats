/**
 * Pure weekly-recurrence enumeration. Given a series spec (RFC5545 BYDAY +
 * a wall-clock start time in an IANA zone, optionally bounded by start/end
 * instants), list the concrete occurrences whose resolved UTC instant falls
 * in a [from, to) window.
 *
 * DST-correct by construction: each occurrence's instant is resolved per local
 * date via `zonedWallClockToUtc`, so a 19:00 raid stays 19:00 *local* across a
 * clock change. The day-walk is done over LOCAL CALENDAR DATE STRINGS (never
 * fixed-24h ms arithmetic), because a fall-back day is 25h and a spring-forward
 * day is 23h — ms-stepping would drift the weekday and double- or skip-count a
 * day around the transition.
 */

import {
  isValidTimeZone,
  localDateInTz,
  zonedWallClockToUtc,
} from "./time";

/** RFC5545 BYDAY token → JS getUTCDay() index (Sun=0). */
const BYDAY_TO_DOW: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

/** The canonical BYDAY tokens, Monday-first for UI ordering. */
export const BYDAY_ORDER = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

export function isValidByday(token: string): boolean {
  return token.toUpperCase() in BYDAY_TO_DOW;
}

export type SeriesSpec = {
  /** RFC5545 BYDAY tokens, e.g. ["TU","TH"]. Case-insensitive. */
  byday: string[];
  /** Wall-clock start "HH:MM" interpreted in `timezone`. */
  startLocal: string;
  /** IANA zone, e.g. "Europe/London". */
  timezone: string;
  /** Inclusive instant lower bound (series first day), or null = unbounded. */
  startsOn: Date | null;
  /** Inclusive instant upper bound (series last day), or null = open-ended. */
  endsOn: Date | null;
};

export type Occurrence = {
  /** Local calendar date "YYYY-MM-DD" — the STABLE materialization key. */
  occurrenceDate: string;
  /** Wall-clock "HH:MM" the instant was derived from. */
  localTime: string;
  timezone: string;
  /** Resolved absolute UTC instant. */
  startsAt: Date;
};

// Defensive cap so a malformed/huge window can never spin forever. 800 days
// comfortably exceeds any sane materialization horizon (we use ~56).
const MAX_WALK_DAYS = 800;

/** getUTCDay() of a "YYYY-MM-DD" calendar date (tz-independent: it's a date). */
function dowOfLocalDate(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** Add `n` calendar days to a "YYYY-MM-DD" string (UTC-anchored, DST-immune). */
function addLocalDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Enumerate occurrences of `spec` whose start instant is in [from, to).
 * `from`/`to` are absolute instants (the materialization window). The series'
 * own `startsOn` (inclusive) and `endsOn` (inclusive) further clamp the range.
 * Returns occurrences sorted ascending by instant.
 */
export function enumerateOccurrences(
  spec: SeriesSpec,
  from: Date,
  to: Date,
): Occurrence[] {
  if (to.getTime() <= from.getTime()) return [];
  if (!isValidTimeZone(spec.timezone)) {
    throw new Error(`invalid timezone "${spec.timezone}"`);
  }
  const wantedDows = new Set<number>();
  for (const tok of spec.byday) {
    const dow = BYDAY_TO_DOW[tok.toUpperCase()];
    if (dow !== undefined) wantedDows.add(dow);
  }
  if (wantedDows.size === 0) return [];

  const fromMs = from.getTime();
  const toMs = to.getTime();
  const startsOnMs = spec.startsOn ? spec.startsOn.getTime() : -Infinity;
  const endsOnMs = spec.endsOn ? spec.endsOn.getTime() : Infinity;

  // Effective instant window for the walk bounds (the per-occurrence test below
  // is authoritative; these just bound how many days we iterate).
  const loMs = Math.max(fromMs, startsOnMs);
  const hiMs = Math.min(toMs, endsOnMs);
  if (hiMs <= loMs) return [];

  // Walk one local day before/after the clamped window to absorb tz-offset
  // slack at the edges; the instant test filters precisely.
  const startDate = addLocalDays(localDateInTz(new Date(loMs), spec.timezone), -1);
  const endDate = addLocalDays(localDateInTz(new Date(hiMs), spec.timezone), 1);

  const out: Occurrence[] = [];
  let cursor = startDate;
  for (let i = 0; i < MAX_WALK_DAYS && cursor <= endDate; i++) {
    if (wantedDows.has(dowOfLocalDate(cursor))) {
      const startsAt = zonedWallClockToUtc(cursor, spec.startLocal, spec.timezone);
      const t = startsAt.getTime();
      // [from, to) window, [startsOn, endsOn] series bounds (both inclusive).
      if (t >= fromMs && t < toMs && t >= startsOnMs && t <= endsOnMs) {
        out.push({
          occurrenceDate: cursor,
          localTime: spec.startLocal,
          timezone: spec.timezone,
          startsAt,
        });
      }
    }
    cursor = addLocalDays(cursor, 1);
  }
  // Walk is already date-ascending, but a tz with sub-day quirks can't reorder
  // whole days — still, sort defensively on instant for a hard guarantee.
  out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return out;
}
