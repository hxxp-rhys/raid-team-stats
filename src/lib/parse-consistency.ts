/**
 * Parse Consistency — pure computation for the `parse_consistency` widget.
 *
 * The widget's whole premise (per the research): leaders bench/coach on
 * MEDIAN and VARIANCE, not best-ever parses. These helpers stay free of
 * server imports so vitest pins the math.
 */

/** Sample standard deviation; null with fewer than 2 values. */
export function stdevOf(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const ss = xs.reduce((s, x) => s + (x - mean) ** 2, 0);
  return Math.sqrt(ss / (xs.length - 1));
}

/**
 * Theil–Sen slope: the median of all pairwise slopes. Chosen over least
 * squares for the trend tab because one lucky/unlucky week shouldn't own
 * the badge (robust to a single outlier week). Needs ≥3 points.
 */
export function theilSen(values: number[]): number | null {
  const n = values.length;
  if (n < 3) return null;
  const slopes: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      slopes.push((values[j]! - values[i]!) / (j - i));
    }
  }
  slopes.sort((a, b) => a - b);
  const mid = Math.floor(slopes.length / 2);
  return slopes.length % 2 === 1
    ? slopes[mid]!
    : (slopes[mid - 1]! + slopes[mid]!) / 2;
}

export type Role = "tank" | "healer" | "dps";

// Spec NAME → role. Names that exist on two classes (Restoration,
// Holy, Protection, Frost...) agree on role wherever they collide for
// tank/healer purposes: Restoration (Druid/Shaman) both heal, Holy
// (Paladin/Priest) both heal, Protection (Warrior/Paladin) both tank.
const HEALER_SPECS = new Set([
  "restoration",
  "holy",
  "discipline",
  "mistweaver",
  "preservation",
]);
const TANK_SPECS = new Set([
  "protection",
  "blood",
  "brewmaster",
  "vengeance",
  "guardian",
]);

/**
 * Role from the Blizzard spec name. Used to flag healer/tank rows while
 * parse ingestion is dps-metric-only — their numbers are real but measure
 * the wrong job, so the UI footnotes them instead of ranking them.
 */
export function roleOf(specName: string | null | undefined): Role {
  const s = (specName ?? "").trim().toLowerCase();
  if (HEALER_SPECS.has(s)) return "healer";
  if (TANK_SPECS.has(s)) return "tank";
  return "dps";
}

/** WCL percentile band, for consistent coloring across the widget. */
export function bandOf(
  p: number,
): "gold" | "pink" | "orange" | "purple" | "blue" | "green" | "grey" {
  if (p >= 100) return "gold";
  if (p >= 99) return "pink";
  if (p >= 95) return "orange";
  if (p >= 75) return "purple";
  if (p >= 50) return "blue";
  if (p >= 25) return "green";
  return "grey";
}

export type TrendWeek = {
  /** Week anchor (epoch ms, Tuesday 15:00 UTC). */
  weekStart: number;
  /** Member's median week-best percentile across encounters that week. */
  median: number;
  /** rel_w = member median − roster median that week. */
  rel: number;
};

/**
 * Slope badge thresholds: ±1.5 percentile-points per QUALIFYING lockout of
 * RELATIVE movement (gaps are compressed out of the axis) is sustained,
 * visible coaching-scale change; inside that band the honest answer is
 * "flat".
 */
export function slopeBadge(slope: number | null): "up" | "down" | "flat" | null {
  if (slope == null) return null;
  if (slope >= 1.5) return "up";
  if (slope <= -1.5) return "down";
  return "flat";
}
