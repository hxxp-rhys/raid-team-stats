/**
 * Attendance Ledger — pure computation for the `attendance_ledger` widget.
 *
 * Merges OBSERVED raid presence (the in-game addon's RaidNightObservation
 * sessions, unioned across observers) with first-party calendar SIGNUPS
 * (EventSignup) into a per-member, per-night attendance picture. Kept free of
 * server imports so vitest pins the scoring + state semantics.
 *
 * Design rules straight from the research (W6):
 *   - "Observed attendance", never inferred intent — a signup and an observed
 *     presence are shown side by side, never conflated.
 *   - Unobserved nights (a scheduled raid no observer's addon saw) are
 *     EXCLUDED from the denominator — counting them as absences would punish
 *     the whole roster for a missing observer.
 *   - MoD scoring: Present = 1.0, Late / Left-early = 0.5, Absent = 0.
 *   - Rolling window + "—" until enough observed nights to be fair.
 */

/** One member's observed first/last-seen within a night (epoch SECONDS). */
export type ObservedMember = { firstSeen: number; lastSeen: number };

export type ObservedNight = {
  /** Stable key (session id or matched-event id). */
  key: string;
  /** Raid start (epoch s) — the matched calendar event's start if known, else
   *  the first observed sample. Drives the late threshold. */
  startedAt: number;
  /** Raid end (epoch s) — last observed sample. Drives the left-early threshold. */
  endedAt: number;
  /** Union across observers: characterId → earliest firstSeen / latest lastSeen. */
  present: Map<string, ObservedMember>;
};

export type NightState =
  | "present"
  | "late"
  | "left_early"
  | "absent"
  | "unobserved";

export const DEFAULT_LATE_MIN = 10;
export const DEFAULT_EARLY_MIN = 15;
/** Below this many observed nights, a member's % is "—" (too few to be fair). */
export const MIN_OBSERVED_NIGHTS = 3;

/**
 * Merge the same night observed by multiple addon observers into one
 * presence map (union; earliest firstSeen, latest lastSeen, widest window).
 * Observations are keyed by their shared night key.
 */
export function mergeObservers(
  observations: Array<{
    key: string;
    startedAt: number;
    endedAt: number;
    present: Array<{ characterId: string; firstSeen: number; lastSeen: number }>;
  }>,
): ObservedNight[] {
  const byKey = new Map<string, ObservedNight>();
  for (const o of observations) {
    let night = byKey.get(o.key);
    if (!night) {
      night = {
        key: o.key,
        startedAt: o.startedAt,
        endedAt: o.endedAt,
        present: new Map(),
      };
      byKey.set(o.key, night);
    } else {
      night.startedAt = Math.min(night.startedAt, o.startedAt);
      night.endedAt = Math.max(night.endedAt, o.endedAt);
    }
    for (const p of o.present) {
      const prev = night.present.get(p.characterId);
      if (!prev) {
        night.present.set(p.characterId, {
          firstSeen: p.firstSeen,
          lastSeen: p.lastSeen,
        });
      } else {
        prev.firstSeen = Math.min(prev.firstSeen, p.firstSeen);
        prev.lastSeen = Math.max(prev.lastSeen, p.lastSeen);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** A member's observed state on one night. */
export function memberNightState(
  night: ObservedNight,
  characterId: string,
  opts: { lateMin?: number; earlyMin?: number } = {},
): NightState {
  const lateMs = (opts.lateMin ?? DEFAULT_LATE_MIN) * 60;
  const earlyMs = (opts.earlyMin ?? DEFAULT_EARLY_MIN) * 60;
  const seen = night.present.get(characterId);
  if (!seen) return "absent";
  // Late takes precedence over left-early — arriving late is the more
  // actionable signal, and a single mid-raid sample can trip both.
  if (seen.firstSeen - night.startedAt > lateMs) return "late";
  if (night.endedAt - seen.lastSeen > earlyMs) return "left_early";
  return "present";
}

const SCORE: Record<NightState, number> = {
  present: 1,
  late: 0.5,
  left_early: 0.5,
  absent: 0,
  unobserved: 0, // excluded from the denominator, so the score never counts
};

export type MemberAttendance = {
  characterId: string;
  /** Per-night state, aligned 1:1 with the input `nights` order. */
  states: NightState[];
  /** Nights this member could be scored on (observed nights). */
  observedNights: number;
  present: number;
  late: number;
  leftEarly: number;
  absent: number;
  /** MoD-weighted score sum over observed nights. */
  score: number;
  /** score / observedNights * 100, or null when below MIN_OBSERVED_NIGHTS. */
  attendancePct: number | null;
};

/**
 * Per-member attendance across the given nights (chronological). Every night
 * here is OBSERVED (the read layer only passes sessions that happened); a
 * member simply not in a night's presence map is `absent`, which is real
 * information. `attendancePct` is null until MIN_OBSERVED_NIGHTS, so a single
 * raid can't read as "100% attendance".
 */
export function computeAttendance(
  nights: ObservedNight[],
  characterIds: string[],
  opts: { lateMin?: number; earlyMin?: number; minNights?: number } = {},
): MemberAttendance[] {
  const minNights = opts.minNights ?? MIN_OBSERVED_NIGHTS;
  return characterIds.map((characterId) => {
    const states: NightState[] = [];
    let present = 0,
      late = 0,
      leftEarly = 0,
      absent = 0,
      score = 0;
    for (const night of nights) {
      const st = memberNightState(night, characterId, opts);
      states.push(st);
      score += SCORE[st];
      if (st === "present") present++;
      else if (st === "late") late++;
      else if (st === "left_early") leftEarly++;
      else if (st === "absent") absent++;
    }
    const observedNights = nights.length;
    return {
      characterId,
      states,
      observedNights,
      present,
      late,
      leftEarly,
      absent,
      score,
      attendancePct:
        observedNights >= minNights ? (score / observedNights) * 100 : null,
    };
  });
}

/** Display label + short glyph for a night state (UI shared constant). */
export const STATE_META: Record<
  NightState,
  { label: string; glyph: string }
> = {
  present: { label: "Present", glyph: "P" },
  late: { label: "Late", glyph: "L" },
  left_early: { label: "Left early", glyph: "E" },
  absent: { label: "Absent", glyph: "A" },
  unobserved: { label: "Unobserved", glyph: "·" },
};
