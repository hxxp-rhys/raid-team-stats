/**
 * Learning Curve — pure computation for the `learning_curve` widget.
 *
 * "Mechanic learning rate": as a team progresses a boss, does each player
 * STOP dying to it? Per player, the boss's wipe pulls (chronological) split
 * into an EARLY and a LATE half; we compare their death rate (and how long
 * they survive into the pull) between the halves. The flag is TEAM-RELATIVE
 * by design — a player is only a coaching candidate if their rate improved
 * LESS than the team's (cancels the "the pull got deeper / harder" confounder
 * that moves everyone at once). Optional avoidable-damage (WCL DamageTaken or
 * the addon's C_DamageMeter) enriches the death signal with near-misses.
 *
 * Kept free of server imports so vitest pins the bucketing + ratio math.
 */

/**
 * One wipe pull from a single player's perspective (chronological order).
 *
 * `died` is the LEARNING-relevant death, NOT "died at all" — on a wipe almost
 * everyone dies, so raw death rate is saturated (~1.0) and carries no signal.
 * The read layer sets `died` = "died EARLY" (death order ≤ 2, i.e. among the
 * first to fall — the deaths that CAUSE wipes), which is not saturated and
 * decays as a player learns the mechanic. `msIntoPull` is the actual death
 * time (early OR late) for the survival-depth signal, independent of `died`.
 */
export type LearnPull = {
  /** Did they die EARLY (caused/contributed to the wipe) on this pull. */
  died: boolean;
  /** ms into the pull they died at all (survival depth); null if survived. */
  msIntoPull: number | null;
  /** Optional: avoidable damage taken this pull (near-miss signal). */
  avoidableDamage?: number | null;
};

export type LearnTrend = "improving" | "flat" | "regressing";

/** One actor's total damage taken from an ability, from `table(DamageTaken)`. */
export type AvoidableEntry = { actorId: number; total: number };

/**
 * Parse the WCL `table(dataType: DamageTaken, abilityID)` JSON scalar into
 * per-actor totals (the avoidable-damage enrichment ingest). Tolerant of the
 * usual JSON quirks; never throws. Mirrors parseDeathsTable.
 */
export function parseDamageTakenTable(raw: unknown): AvoidableEntry[] {
  const rec = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const entries = rec(rec(raw).data).entries;
  const arr = Array.isArray(entries) ? entries : [];
  const out: AvoidableEntry[] = [];
  for (const e of arr) {
    const o = rec(e);
    const actorId = typeof o.id === "number" ? o.id : null;
    const total = typeof o.total === "number" ? o.total : null;
    if (actorId != null && total != null) out.push({ actorId, total });
  }
  return out;
}

export type MemberLearning = {
  characterId: string;
  pulls: number;
  earlyPulls: number;
  latePulls: number;
  /** deaths / pulls in each half. */
  earlyDeathRate: number;
  lateDeathRate: number;
  /** late ÷ early death rate (<1 improving); null if early rate is 0. */
  ratio: number | null;
  /** ratio ÷ the team's AGGREGATE ratio (>1 = learning slower than the team). */
  relativeRatio: number | null;
  /** median survival ms, early vs late (rises as they progress deeper). */
  earlySurvivalMs: number | null;
  lateSurvivalMs: number | null;
  /** avoidable-damage/pull, early vs late (null when no meter data). */
  earlyAvoidable: number | null;
  lateAvoidable: number | null;
  trend: LearnTrend;
  /** Team-relative coaching flag: improved meaningfully less than the team. */
  flagged: boolean;
};

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Minimum present-pulls in EACH half for a player to be scored. */
export const MIN_BUCKET_PULLS = 6;
/** Team-relative ratio above which a player is flagged (research: 1.3). */
export const FLAG_RATIO = 1.3;
/** Per-player improvement thresholds for the trend badge. */
const IMPROVE_RATIO = 0.7;
const REGRESS_RATIO = 1.3;

/**
 * Compute per-member learning over a boss's chronological wipe pulls.
 * `pullsByMember` maps characterId → that member's pulls IN ORDER (only pulls
 * they were present for). Members with < 2·MIN_BUCKET_PULLS pulls are omitted.
 */
export function computeLearning(
  pullsByMember: Map<string, LearnPull[]>,
  opts: { minBucket?: number } = {},
): MemberLearning[] {
  const minBucket = opts.minBucket ?? MIN_BUCKET_PULLS;

  type Raw = Omit<MemberLearning, "relativeRatio" | "trend" | "flagged">;
  const raws: Raw[] = [];
  for (const [characterId, pulls] of pullsByMember) {
    if (pulls.length < minBucket * 2) continue;
    const half = Math.floor(pulls.length / 2);
    const early = pulls.slice(0, half);
    const late = pulls.slice(pulls.length - half); // last `half` (skips a middle pull on odd counts)

    const rate = (b: LearnPull[]) => b.filter((p) => p.died).length / b.length;
    const earlyDeathRate = rate(early);
    const lateDeathRate = rate(late);
    const ratio = earlyDeathRate > 0 ? lateDeathRate / earlyDeathRate : null;

    // Survival depth uses ANY death time (early or late), independent of the
    // early-death `died` flag — "when they fall, how deep did they get".
    const survival = (b: LearnPull[]) =>
      median(
        b.filter((p) => p.msIntoPull != null).map((p) => p.msIntoPull!),
      );
    const avoid = (b: LearnPull[]) => {
      const vals = b
        .map((p) => p.avoidableDamage)
        .filter((v): v is number => typeof v === "number");
      return vals.length ? vals.reduce((s, v) => s + v, 0) / b.length : null;
    };

    raws.push({
      characterId,
      pulls: pulls.length,
      earlyPulls: early.length,
      latePulls: late.length,
      earlyDeathRate,
      lateDeathRate,
      ratio,
      earlySurvivalMs: survival(early),
      lateSurvivalMs: survival(late),
      earlyAvoidable: avoid(early),
      lateAvoidable: avoid(late),
    });
  }

  // Team baseline: the AGGREGATE late÷early death rate across everyone (pooled
  // counts, not a median of per-player ratios — which degenerates to 0 the
  // moment a couple of players fully stop dying). Cancels the progression-
  // depth confounder: if the whole team's rate fell, the baseline falls too.
  let teEarlyD = 0,
    teEarlyP = 0,
    teLateD = 0,
    teLateP = 0;
  for (const r of raws) {
    teEarlyD += r.earlyDeathRate * r.earlyPulls;
    teEarlyP += r.earlyPulls;
    teLateD += r.lateDeathRate * r.latePulls;
    teLateP += r.latePulls;
  }
  const teamEarlyRate = teEarlyP > 0 ? teEarlyD / teEarlyP : 0;
  const teamLateRate = teLateP > 0 ? teLateD / teLateP : 0;
  const teamRatio = teamEarlyRate > 0 ? teamLateRate / teamEarlyRate : null;

  return raws.map((r) => {
    const relativeRatio =
      r.ratio != null && teamRatio != null && teamRatio > 0
        ? r.ratio / teamRatio
        : null;
    // Trend from the player's own ratio; flag from the team-relative one.
    let trend: LearnTrend = "flat";
    if (r.ratio != null) {
      if (r.ratio <= IMPROVE_RATIO) trend = "improving";
      else if (r.ratio >= REGRESS_RATIO) trend = "regressing";
    }
    // Flag a coaching candidate only when they (a) improved meaningfully less
    // than the team AND (b) are STILL at or above the team's current early-
    // death rate. Without (b), a player with a low-but-flat rate gets flagged
    // just because the rest of the team improved past them — a false positive.
    const flagged =
      relativeRatio != null &&
      relativeRatio >= FLAG_RATIO &&
      r.lateDeathRate > 0 &&
      r.lateDeathRate >= teamLateRate;
    return { ...r, relativeRatio, trend, flagged };
  });
}
