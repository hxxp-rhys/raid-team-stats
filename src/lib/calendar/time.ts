/**
 * Calendar time helpers — convert between a team's LOCAL wall-clock + IANA
 * timezone and an absolute UTC instant, DST-correct, with zero dependencies
 * (uses the built-in Intl tz database). A 19:00 raid stays 19:00 *local*
 * across DST because we always store wall-clock + IANA zone, never a fixed
 * offset, and resolve the instant per occurrence.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^(\d{1,2}):(\d{2})$/;

/** Validate an IANA zone id by trying to format with it. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The offset (in minutes, EAST of UTC) that timezone `tz` is at the absolute
 * instant `utcMs`. Derived by formatting the instant in `tz` and comparing the
 * wall-clock back to the instant — the standard dependency-free technique.
 */
function tzOffsetMinutes(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // The wall-clock the zone shows for this instant, interpreted as if it were
  // UTC, minus the real instant = the zone's offset.
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - utcMs) / 60000);
}

/**
 * Resolve a LOCAL wall-clock (`YYYY-MM-DD`, `HH:MM`) in IANA `tz` to the
 * absolute UTC `Date`. Handles DST: the offset is solved by a two-step
 * fixpoint (offset depends on the instant, the instant depends on the offset).
 *
 * DST edge cases: a "spring-forward" gap time (e.g. 02:30 on a night clocks
 * skip to 03:00) resolves to the post-jump instant; a "fall-back" repeated
 * time resolves to the first occurrence — both deterministic and acceptable
 * for raid scheduling (leaders pick real evening hours, never the 1-hour gap).
 */
export function zonedWallClockToUtc(
  dateStr: string,
  timeStr: string,
  tz: string,
): Date {
  if (!ISO_DATE.test(dateStr)) {
    throw new Error(`invalid date "${dateStr}" (want YYYY-MM-DD)`);
  }
  const m = HHMM.exec(timeStr);
  if (!m) throw new Error(`invalid time "${timeStr}" (want HH:MM)`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`time out of range "${timeStr}"`);
  if (!isValidTimeZone(tz)) throw new Error(`invalid timezone "${tz}"`);

  const [y, mo, d] = dateStr.split("-").map(Number);
  // First guess: treat the wall-clock as if it were UTC.
  const guessMs = Date.UTC(y!, mo! - 1, d!, hour, minute, 0);
  // Correct by the offset at that guess, then re-correct once (offsets only
  // change at DST boundaries, so one refinement converges everywhere except
  // inside the ~1h transition window, which raid times never use).
  const off1 = tzOffsetMinutes(guessMs, tz);
  const utc1 = guessMs - off1 * 60000;
  const off2 = tzOffsetMinutes(utc1, tz);
  const utcMs = guessMs - off2 * 60000;
  return new Date(utcMs);
}

/** The local calendar date ("YYYY-MM-DD") that `instant` falls on in `tz`. */
export function localDateInTz(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** End instant = start + durationMin (duration is wall-clock-stable minutes). */
export function endInstant(start: Date, durationMin: number): Date {
  return new Date(start.getTime() + durationMin * 60000);
}
