/**
 * Progression Curve — pure computation for the `prog_curve` widget.
 *
 * Operates on per-pull fight rows ingested by Guild Report Sync. Kept free
 * of server imports so vitest can pin the semantics: duplicate-log dedupe,
 * throwaway-pull filtering, progress axes, night clustering, pace, and the
 * late-night decay chip.
 */

export type Pull = {
  reportCode: string;
  fightId: number;
  encounterId: number;
  difficulty: number;
  kill: boolean;
  /** Boss HP % remaining at end of pull (0 on kills). */
  bossPct: number | null;
  /** Overall fight % remaining incl. phase weighting. */
  fightPct: number | null;
  lastPhase: number | null;
  startAt: number; // epoch ms
  endAt: number;
  durationMs: number;
  /** Length of the source report — dedupe keeps the longer-coverage log. */
  reportDurationMs: number;
};

/**
 * Duplicate-log dedupe. Two people logging the same raid produce the same
 * pull twice; counting both corrupts every downstream stat, so this MUST
 * run before anything else. Same encounter+difficulty, start within ±10s,
 * duration within ±5s → same pull; keep the one from the longer report.
 */
export function dedupePulls(pulls: Pull[]): Pull[] {
  const sorted = [...pulls].sort((a, b) => a.startAt - b.startAt);
  const kept: Pull[] = [];
  for (const p of sorted) {
    const dupIdx = kept.findIndex(
      (k) =>
        k.encounterId === p.encounterId &&
        k.difficulty === p.difficulty &&
        k.reportCode !== p.reportCode &&
        Math.abs(k.startAt - p.startAt) <= 10_000 &&
        Math.abs(k.durationMs - p.durationMs) <= 5_000,
    );
    if (dupIdx === -1) {
      kept.push(p);
      continue;
    }
    if (p.reportDurationMs > kept[dupIdx]!.reportDurationMs) {
      kept[dupIdx] = p;
    }
  }
  return kept;
}

/**
 * Progress made on a pull, 0–100. Kills are always 100.
 *
 * The "fight" axis uses WCL's fightPercentage, which is already phase-weighted
 * and monotonic across a fight. The "boss" axis is PHASE-AWARE overall progress
 * (see `bossProgressOf`): raw `bossPercentage` is the HP of the LAST REACHED
 * PHASE and resets to ~100 each phase, so it is NOT monotonic on multi-phase
 * bosses and must never be charted directly. `progressOf(p, "boss")` therefore
 * delegates to `bossProgressOf` with `phasesTotal` computed from the pull's own
 * `lastPhase` — callers that have the whole encounter should prefer
 * `bossProgressOf(p, phasesTotalOf(pulls))` so every pull shares one scale.
 *
 * A pull with neither percentage reads as 0 progress, never as null — by this
 * point the row IS a real pull; only its depth is unknown.
 */
export function progressOf(p: Pull, axis: "fight" | "boss" = "fight"): number {
  if (p.kill) return 100;
  if (axis === "boss") return bossProgressOf(p, p.lastPhase ?? 1);
  const remaining = p.fightPct ?? p.bossPct;
  if (remaining == null) return 0;
  return Math.min(100, Math.max(0, 100 - remaining));
}

/**
 * Highest phase reached across an encounter's pulls — the denominator for
 * phase-aware boss progress. A kill reaches the final phase, so this is the
 * boss's phase count in practice. Returns 1 when no pull carries a phase (the
 * fallback path then collapses `bossProgressOf` to raw `100 - bossPct`).
 */
export function phasesTotalOf(pulls: Pull[]): number {
  let max = 1;
  for (const p of pulls) {
    if (p.lastPhase != null && p.lastPhase > max) max = p.lastPhase;
  }
  return max;
}

/**
 * PHASE-AWARE overall boss progress, 0–100 and MONOTONIC: a deeper phase OR a
 * lower `bossPct` within a phase always ranks higher. Maps each pull onto one
 * shared 0–100% scale spanning the whole fight:
 *
 *   progress = ((lastPhase - 1) + (100 - bossPct)/100) / phasesTotal * 100
 *
 * where `phasesTotal` is the max phase observed across the encounter
 * (`phasesTotalOf`). Phase k contributes the band [(k-1)/phasesTotal,
 * k/phasesTotal] and the within-phase HP burned fills that band, so the bands
 * meet exactly at phase boundaries — no inversion where a deep P3 wipe
 * (high bossPct) would otherwise plot below a shallow P1 wipe.
 *
 * Fallback to the raw `100 - bossPct` when phase data is missing (lastPhase
 * null/0) or there is only one phase (phasesTotal ≤ 1) — nothing to weight.
 * Kills always map to 100.
 */
export function bossProgressOf(p: Pull, phasesTotal: number): number {
  if (p.kill) return 100;
  const bossPct = p.bossPct ?? p.fightPct;
  if (bossPct == null) return 0;
  const lastPhase = p.lastPhase ?? 0;
  if (lastPhase < 1 || phasesTotal <= 1) {
    return Math.min(100, Math.max(0, 100 - bossPct));
  }
  const progress =
    ((lastPhase - 1 + (100 - bossPct) / 100) / phasesTotal) * 100;
  return Math.min(100, Math.max(0, progress));
}

export type ThrowawayOptions = {
  /** Pulls shorter than this are resets/mispulls. */
  minDurationMs?: number;
  /** AND-pair: barely-scratched (≥ this % remaining) … */
  resetPctFloor?: number;
  /** …and shorter than this → a called reset, not an attempt. */
  resetMaxMs?: number;
};

/**
 * Throwaway-pull detection: sub-25s pulls, and "barely scratched + short"
 * resets. Kills are never throwaway. Filtered pulls are EXCLUDED from
 * trends but the UI must show "n excluded" — silent dropping reads as
 * fewer pulls than the raid actually spent.
 */
export function isThrowaway(p: Pull, opts: ThrowawayOptions = {}): boolean {
  const {
    minDurationMs = 25_000,
    resetPctFloor = 99,
    resetMaxMs = 60_000,
  } = opts;
  if (p.kill) return false;
  if (p.durationMs < minDurationMs) return true;
  const remaining = p.fightPct ?? p.bossPct;
  return (
    remaining != null && remaining >= resetPctFloor && p.durationMs < resetMaxMs
  );
}

/**
 * Cluster pulls into raid nights: any gap longer than `gapMs` (default 6h)
 * starts a new night. Input order does not matter; nights and the pulls
 * within them come back chronological.
 */
export function nightsOf(pulls: Pull[], gapMs = 6 * 60 * 60 * 1000): Pull[][] {
  const sorted = [...pulls].sort((a, b) => a.startAt - b.startAt);
  const nights: Pull[][] = [];
  for (const p of sorted) {
    const night = nights[nights.length - 1];
    const last = night?.[night.length - 1];
    if (!night || !last || p.startAt - last.endAt > gapMs) {
      nights.push([p]);
    } else {
      night.push(p);
    }
  }
  return nights;
}

/**
 * Per-night "buckets" for the curve's date brackets + separators: the FIRST and
 * LAST pull index of each night (chronological), the night's start/end time, and
 * its pull count. The indexes align with the displayed pull order (the widget
 * sorts pulls chronologically, same as nightsOf), so `firstIndex`/`lastIndex`
 * give the x-span of the night's date bracket and `startAt`/`endAt` its date
 * range (a night that crosses local midnight spans two dates).
 */
export function nightBuckets(
  pulls: Pull[],
  gapMs = 6 * 60 * 60 * 1000,
): Array<{
  firstIndex: number;
  lastIndex: number;
  startAt: number;
  endAt: number;
  count: number;
}> {
  const nights = nightsOf(pulls, gapMs);
  const out: Array<{
    firstIndex: number;
    lastIndex: number;
    startAt: number;
    endAt: number;
    count: number;
  }> = [];
  let idx = 0;
  for (const n of nights) {
    out.push({
      firstIndex: idx,
      lastIndex: idx + n.length - 1,
      startAt: n[0]!.startAt,
      endAt: n[n.length - 1]!.endAt,
      count: n.length,
    });
    idx += n.length;
  }
  return out;
}

/** Running maximum — the "best progress so far" line. */
export function rollingBest(values: number[]): number[] {
  let best = -Infinity;
  return values.map((v) => (best = Math.max(best, v)));
}

/**
 * Least-squares slope (progress %-points per pull) over the trailing
 * `lastN` values. Needs ≥3 points; otherwise null. Feed it throwaway-
 * filtered wipe progress — kills and resets both distort the trend.
 */
export function slopeOf(values: number[], lastN = 15): number | null {
  const ys = values.slice(-lastN);
  const n = ys.length;
  if (n < 3) return null;
  const xMean = (n - 1) / 2;
  const yMean = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (ys[i]! - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? null : num / den;
}

export type NightPace = {
  pulls: number;
  /** First pull start → last pull end. */
  spanMs: number;
  /** Gaps > 20 min between consecutive pulls. */
  breaks: Array<{ startAt: number; endAt: number }>;
  /** Pulls per hour of ACTIVE time (span minus breaks). */
  pullsPerHour: number | null;
};

export function paceOf(
  night: Pull[],
  breakThresholdMs = 20 * 60 * 1000,
): NightPace {
  const sorted = [...night].sort((a, b) => a.startAt - b.startAt);
  if (sorted.length === 0) {
    return { pulls: 0, spanMs: 0, breaks: [], pullsPerHour: null };
  }
  const breaks: Array<{ startAt: number; endAt: number }> = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]!.startAt - sorted[i - 1]!.endAt;
    if (gap > breakThresholdMs) {
      breaks.push({ startAt: sorted[i - 1]!.endAt, endAt: sorted[i]!.startAt });
    }
  }
  const spanMs = sorted[sorted.length - 1]!.endAt - sorted[0]!.startAt;
  const breakMs = breaks.reduce((s, b) => s + (b.endAt - b.startAt), 0);
  const activeMs = Math.max(0, spanMs - breakMs);
  return {
    pulls: sorted.length,
    spanMs,
    breaks,
    pullsPerHour:
      activeMs > 0 ? sorted.length / (activeMs / 3_600_000) : null,
  };
}

export type DecayChip = {
  encounterId: number;
  finalHourMedian: number;
  nightMedian: number;
  /** Negative = the final hour ran worse than the night overall. */
  delta: number;
};

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * Late-night quality decay — DESCRIPTIVE ONLY (the spec is explicit that
 * this is a chip, not a verdict). Same-boss comparison: the night's
 * most-pulled encounter, its pulls inside the NIGHT's final hour vs all of
 * its pulls that night, both buckets needing ≥5 pulls (whole-night bucket
 * ≥2×). The final hour anchors to the night's last pull overall — if the
 * team swapped to farm at the end, the prog boss has no final-hour pulls
 * and the chip honestly stays null. Callers must feed throwaway-FILTERED
 * pulls: end-of-night resets cluster in exactly the final-hour bucket and
 * would bias the chip toward a false "raid is tired". Small nightly samples
 * are the norm — null means "not enough data", which most nights will be.
 */
export function decayChipOf(
  night: Pull[],
  axis: "fight" | "boss" = "fight",
  minPerBucket = 5,
): DecayChip | null {
  if (night.length === 0) return null;
  const byEncounter = new Map<number, Pull[]>();
  for (const p of night) {
    byEncounter.set(p.encounterId, [
      ...(byEncounter.get(p.encounterId) ?? []),
      p,
    ]);
  }
  const [encounterId, pulls] = [...byEncounter.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )[0]!;
  const sorted = [...pulls].sort((a, b) => a.startAt - b.startAt);
  const nightEnd = Math.max(...night.map((p) => p.endAt));
  const finalHour = sorted.filter((p) => nightEnd - p.startAt <= 3_600_000);
  if (finalHour.length < minPerBucket || sorted.length < minPerBucket * 2) {
    return null;
  }
  const fh = median(finalHour.map((p) => progressOf(p, axis)));
  const all = median(sorted.map((p) => progressOf(p, axis)));
  if (fh == null || all == null) return null;
  return {
    encounterId,
    finalHourMedian: fh,
    nightMedian: all,
    delta: fh - all,
  };
}
