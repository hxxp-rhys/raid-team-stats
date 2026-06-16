/**
 * Engagement Pulse — pure computation for the `engagement_pulse` widget.
 *
 * Reads nothing; the tRPC procedure feeds it rows from the VaultSnapshot
 * weekly ledger (one row per character per raid week) plus the churn
 * watchlist signals. Kept free of server imports so vitest can exercise the
 * decay/risk semantics directly.
 *
 * Framing contract (per the research spec): this widget measures ACTIVITY,
 * not attendance, and is a "check in — don't conclude" surface. Unknown
 * weeks (no snapshot row — sync gap or member not yet tracked) must never
 * be treated as inactive, and a member is only watchlisted when multiple
 * independent signals agree.
 */

/** Weekly activity score: raid vault slots + M+ vault slots unlocked, 0–6. */
export type WeekScore = number | null; // null = unknown, NOT zero

/** US weekly reset anchor: Tuesday 15:00 UTC (matches the Tier-A vault writer). */
export function weekStartUtc(now: Date): Date {
  const ws = new Date(now);
  const daysSinceTuesday = (now.getUTCDay() - 2 + 7) % 7;
  ws.setUTCDate(now.getUTCDate() - daysSinceTuesday);
  ws.setUTCHours(15, 0, 0, 0);
  if (ws > now) ws.setUTCDate(ws.getUTCDate() - 7);
  return ws;
}

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The `count` CLOSED week starts before the current (in-progress) week,
 * oldest → newest. The current week is excluded — it can only score lower
 * than its final value and would read as a false decline.
 */
export function closedWeekStarts(now: Date, count: number): Date[] {
  const current = weekStartUtc(now).getTime();
  const out: Date[] = [];
  for (let i = count; i >= 1; i--) out.push(new Date(current - i * WEEK_MS));
  return out;
}

export function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export type DecayResult = {
  flagged: boolean;
  /** Median of up to 6 known closed weeks preceding the evaluation window. */
  baseline: number | null;
  /** The two most recent closed-week scores (the evaluation window). */
  recent: [WeekScore, WeekScore];
  /** Known (non-null) closed weeks available in total. */
  knownWeeks: number;
};

/**
 * Decay detection over closed-week scores (oldest → newest).
 *
 * Spec: flag when the two most recent closed weeks are each ≤ 0.5 × the
 * personal baseline, the baseline is ≥ 2, and ≥ 4 closed weeks of history
 * exist. The baseline is the median of up to 6 KNOWN weeks that PRECEDE the
 * two evaluated weeks — excluding them so a fresh two-week dropoff doesn't
 * drag down the very baseline it is measured against. Unknown weeks are
 * skipped (never counted as zero); if either evaluated week is unknown the
 * flag stays off (conservative — a sync gap is not evidence of decay).
 */
export function decayFlag(closedScores: WeekScore[]): DecayResult {
  const known = closedScores.filter((s): s is number => s != null);
  const recent: [WeekScore, WeekScore] = [
    closedScores[closedScores.length - 2] ?? null,
    closedScores[closedScores.length - 1] ?? null,
  ];
  const baselineWindow = closedScores
    .slice(0, Math.max(0, closedScores.length - 2))
    .filter((s): s is number => s != null)
    .slice(-6);
  const baseline = medianOf(baselineWindow);
  const flagged =
    known.length >= 4 &&
    baseline != null &&
    baseline >= 2 &&
    recent[0] != null &&
    recent[1] != null &&
    recent[0] <= 0.5 * baseline &&
    recent[1] <= 0.5 * baseline;
  return { flagged, baseline, recent, knownWeeks: known.length };
}

export type RiskSignals = {
  /** 1 = decay-flagged, 0.5 = latest known closed week ≤ 0.5 × baseline. */
  activity: number;
  /** Days since last in-game login: ≥14 → 1, ≥7 → 0.5. Unknown → 0. */
  login: number;
  /** Season-over-season M+ collapse, gated on previous ≥ 500. */
  mplus: number;
  /** Guild-roster absence streak from the departure cascade. */
  absence: number;
};

export function activitySignal(d: DecayResult): number {
  if (d.flagged) return 1;
  const latest = d.recent[1];
  if (d.baseline != null && d.baseline >= 2 && latest != null && latest <= 0.5 * d.baseline) {
    return 0.5;
  }
  return 0;
}

export function loginSignal(daysSinceLogin: number | null): number {
  if (daysSinceLogin == null) return 0; // unknown never penalizes
  if (daysSinceLogin >= 14) return 1;
  if (daysSinceLogin >= 7) return 0.5;
  return 0;
}

/**
 * Season-over-season M+ delta. Only meaningful when the player was a real
 * M+ player last season (previous ≥ 500); below that, "decline" is noise.
 * NOTE: "previous" currently crosses the TWW→Midnight expansion boundary —
 * early-season scores are structurally lower, so this signal contributes,
 * it never decides (see watchlisted()).
 */
export function mplusSignal(
  current: number | null,
  previous: number | null,
): number {
  if (previous == null || previous < 500) return 0;
  const cur = current ?? 0;
  const ratio = cur / previous;
  if (ratio < 0.4) return 1;
  if (ratio < 0.7) return 0.5;
  return 0;
}

export function absenceSignal(consecutiveAbsences: number): number {
  return Math.min(1, Math.max(0, consecutiveAbsences) * 0.5);
}

export function riskScore(s: RiskSignals): number {
  return 0.4 * s.activity + 0.25 * s.login + 0.2 * s.mplus + 0.15 * s.absence;
}

// ── Weighted weekly engagement index (the trend-line score) ─────────────────

/** The per-week metrics the engagement index is built from (one raid week). */
export type EngagementCell = {
  score: number | null; // raid+M+ vault slots, 0–6; null = unobserved week
  raidUnlocked: number | null; // 0–3
  mplusUnlocked: number | null; // 0–3
  mplusRuns: number | null;
  raided: boolean; // a logged raid kill that week
};

/**
 * Weights for the combined engagement index. RAID-team-appropriate: raid
 * activity (vault progress + an actually-logged kill) dominates; M+ vault and
 * run frequency are the breadth signals. Documented + summing to 1 so the
 * index is a transparent 0–100, never a vanity number. The per-metric lines on
 * the player drill-in show exactly what moved the combined score.
 */
export const ENGAGEMENT_WEIGHTS = {
  raidVault: 0.35,
  raided: 0.25,
  mplusVault: 0.25,
  mplusRuns: 0.15,
} as const;
/** M+ runs are normalised against this weekly cap (a full-clear week of keys). */
export const MPLUS_RUNS_CAP = 8;

/** Each metric normalised to 0–100 for the drill-in lines; null on a gap week. */
export function engagementComponents(cell: EngagementCell): {
  raidVault: number;
  raided: number;
  mplusVault: number;
  mplusRuns: number;
} | null {
  // A week is OBSERVED if there's any positive evidence the player was active:
  // a vault row (score != null), a logged raid kill, or actual M+ runs. Weeks
  // with no such evidence stay null (a gap, never a false zero). This lets a
  // raid-only or keys-only week still plot a point even when the vault snapshot
  // for that week is missing.
  const observed =
    cell.score != null || cell.raided || (cell.mplusRuns ?? 0) > 0;
  if (!observed) return null;
  return {
    raidVault: (Math.min(Math.max(cell.raidUnlocked ?? 0, 0), 3) / 3) * 100,
    raided: cell.raided ? 100 : 0,
    mplusVault: (Math.min(Math.max(cell.mplusUnlocked ?? 0, 0), 3) / 3) * 100,
    mplusRuns:
      (Math.min(Math.max(cell.mplusRuns ?? 0, 0), MPLUS_RUNS_CAP) /
        MPLUS_RUNS_CAP) *
      100,
  };
}

/**
 * Combined weighted engagement index for one week, 0–100. Returns null for an
 * UNOBSERVED week (no vault row) so the trend line breaks rather than dropping
 * to a false zero — a sync gap is not disengagement.
 */
export function weeklyEngagementScore(cell: EngagementCell): number | null {
  const c = engagementComponents(cell);
  if (c == null) return null;
  const w = ENGAGEMENT_WEIGHTS;
  return Math.round(
    w.raidVault * c.raidVault +
      w.raided * c.raided +
      w.mplusVault * c.mplusVault +
      w.mplusRuns * c.mplusRuns,
  );
}

export type EngagementTrend = {
  dir: "up" | "down" | "flat";
  /** Mean(recent half) − mean(earlier half) of OBSERVED weeks, or null. */
  delta: number | null;
};

/**
 * Trend direction over a series of weekly index values (oldest → newest).
 * Compares the recent half against the earlier half of the OBSERVED (non-null)
 * weeks, with a ±5-point deadband so noise reads as "flat". Needs ≥3 observed
 * weeks to call a direction at all.
 */
export function engagementTrend(scores: Array<number | null>): EngagementTrend {
  const obs = scores.filter((s): s is number => s != null);
  if (obs.length < 3) return { dir: "flat", delta: null };
  const half = Math.floor(obs.length / 2);
  const mean = (a: number[]) => a.reduce((p, c) => p + c, 0) / a.length;
  const delta = Math.round(mean(obs.slice(half)) - mean(obs.slice(0, half)));
  return { dir: delta > 5 ? "up" : delta < -5 ? "down" : "flat", delta };
}

/**
 * How many consecutive trailing OBSERVED weeks the player's weighted index has
 * sat at or below half their own median — a sustained slump. Gaps (unknown
 * weeks) are skipped, never break the run. Used to escalate a current concern
 * from "caution" to "critical" once it has persisted (≥3 weeks). Requires a
 * meaningful median (≥20) so a chronically-casual player isn't mislabeled as
 * "declining" (their recent weeks aren't BELOW their own norm).
 */
export function concerningStreak(scores: Array<number | null>): number {
  const obs = scores.filter((s): s is number => s != null);
  if (obs.length < 3) return 0;
  const base = medianOf(obs);
  if (base == null || base < 20) return 0;
  let streak = 0;
  for (let i = scores.length - 1; i >= 0; i--) {
    const s = scores[i];
    if (s == null) continue; // gap — skip, don't break the run
    if (s <= 0.5 * base) streak++;
    else break;
  }
  return streak;
}

/**
 * Watchlist membership = weighted AND-ing: at least TWO independent signals
 * non-zero AND the weighted score clears the floor. A single signal — even a
 * strong one — only ever ranks, it never lists (vacation ≠ churn).
 */
export function watchlisted(s: RiskSignals): boolean {
  const active = [s.activity, s.login, s.mplus, s.absence].filter(
    (v) => v > 0,
  ).length;
  return active >= 2 && riskScore(s) >= 0.35;
}
