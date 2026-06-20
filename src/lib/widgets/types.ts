import { z } from "zod";

/**
 * Dashboard widget catalogue. Each widget type maps to:
 *   - a React component that fetches data via tRPC and renders
 *   - a meta entry (title, description) used by the palette UI
 *   - an optional zod schema for the per-instance `config`
 *
 * Adding a new widget = add to WIDGET_TYPES, register a component in
 * src/components/widgets/index.tsx, and add a meta entry. The dashboard
 * layout JSON in the DB stays forward-compatible: unknown widget types are
 * skipped on render rather than crashing the page.
 */

export const WIDGET_TYPES = [
  "ilvl_roster",
  "mplus_ladder",
  "vault_progress",
  "raid_completion",
  "tier_set_tracker",
  "wcl_parses",
  "character_timeline",
  "class_composition",
  "ilvl_distribution",
  "missing_fixes",
  "mplus_weekly",
  "talent_loadouts",
  "parses_heatmap",
  "recent_kills",
  "keystones",
  "weekly_lockouts",
  "upgrade_currencies",
  "consumable_readiness",
  "delve_progress",
  "talent_builds",
  "engagement_pulse",
  "prog_curve",
  "parse_consistency",
  "professions",
  "first_death_ledger",
  "attendance_ledger",
  "learning_curve",
  "tonight_ready",
  "bench_equity",
  "brez_economy",
  "cooldown_usage",
] as const;

export type WidgetType = (typeof WIDGET_TYPES)[number];

const widgetTypeSchema = z.enum(WIDGET_TYPES);

// 8× finer grid than the original 12-col layout (96 desktop / 32 mobile)
// for fine-grained widget sizing + drag placement. Each step ≈ 1% width.
export const RESOLUTION = 8;
export const DESKTOP_GRID_COLS = 12 * RESOLUTION; // 96
export const MOBILE_GRID_COLS = 4 * RESOLUTION; // 32
// Row band height in px — small so vertical sizing is as fine as horizontal.
export const ROW_HEIGHT_PX = 12;
export const MAX_WIDGET_COLS = DESKTOP_GRID_COLS;
export const MAX_WIDGET_ROWS = 8 * RESOLUTION; // 64

export const widgetInstanceSchema = z.object({
  id: z.string().min(1),
  type: widgetTypeSchema,
  // Span in grid cells on the 48-col (desktop) / 16-col (mobile) grid.
  cols: z.number().int().min(1).max(MAX_WIDGET_COLS).optional(),
  rows: z.number().int().min(1).max(MAX_WIDGET_ROWS).optional(),
  // Explicit top-left grid position (0-indexed). When present the widget is
  // placed there; when absent it auto-flows. Set by drag-to-move.
  x: z.number().int().min(0).max(MAX_WIDGET_COLS - 1).optional(),
  y: z.number().int().min(0).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type WidgetInstance = z.infer<typeof widgetInstanceSchema>;

export const DEFAULT_WIDGET_COLS = 4 * RESOLUTION;
export const DEFAULT_WIDGET_ROWS = 2 * RESOLUTION;

/**
 * Per-widget recommended default size on the desktop grid (already scaled to
 * the 48-col resolution). Used by the "Add widget" flow so a freshly-dropped
 * widget lands at the right size for its content.
 */
const BASE_SIZE: Record<WidgetType, { cols: number; rows: number }> = {
  ilvl_roster: { cols: 12, rows: 4 },
  mplus_ladder: { cols: 6, rows: 4 },
  vault_progress: { cols: 6, rows: 3 },
  raid_completion: { cols: 12, rows: 4 },
  tier_set_tracker: { cols: 6, rows: 3 },
  wcl_parses: { cols: 6, rows: 4 },
  character_timeline: { cols: 8, rows: 3 },
  class_composition: { cols: 4, rows: 3 },
  ilvl_distribution: { cols: 8, rows: 3 },
  missing_fixes: { cols: 6, rows: 3 },
  mplus_weekly: { cols: 6, rows: 4 },
  talent_loadouts: { cols: 6, rows: 4 },
  parses_heatmap: { cols: 12, rows: 4 },
  recent_kills: { cols: 4, rows: 4 },
  keystones: { cols: 6, rows: 4 },
  weekly_lockouts: { cols: 6, rows: 4 },
  upgrade_currencies: { cols: 6, rows: 4 },
  consumable_readiness: { cols: 6, rows: 3 },
  delve_progress: { cols: 4, rows: 3 },
  talent_builds: { cols: 6, rows: 4 },
  engagement_pulse: { cols: 12, rows: 4 },
  prog_curve: { cols: 12, rows: 4 },
  parse_consistency: { cols: 12, rows: 4 },
  professions: { cols: 6, rows: 4 },
  first_death_ledger: { cols: 8, rows: 4 },
  attendance_ledger: { cols: 8, rows: 4 },
  learning_curve: { cols: 8, rows: 4 },
  tonight_ready: { cols: 6, rows: 4 },
  bench_equity: { cols: 8, rows: 4 },
  brez_economy: { cols: 6, rows: 4 },
  cooldown_usage: { cols: 8, rows: 4 },
};
export const WIDGET_DEFAULT_SIZE: Record<
  WidgetType,
  { cols: number; rows: number }
> = Object.fromEntries(
  Object.entries(BASE_SIZE).map(([k, v]) => [
    k,
    { cols: v.cols * RESOLUTION, rows: v.rows * RESOLUTION },
  ]),
) as Record<WidgetType, { cols: number; rows: number }>;

/**
 * A named tab grouping widgets together. Dashboards may have one or many
 * tabs; the editor lets owners reorder + rename tabs and move widgets
 * between them.
 */
// Resilient widget list: drop any entry that doesn't match the current
// widget schema (e.g. a widget type that was removed from the catalogue)
// instead of failing the whole layout parse. This keeps a dashboard from
// being wiped when a widget type is retired.
const resilientWidgetArray = z.preprocess(
  (val) => {
    if (!Array.isArray(val)) return [];
    return val.filter((w) => widgetInstanceSchema.safeParse(w).success);
  },
  z.array(widgetInstanceSchema).default([]),
);

export const dashboardTabSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(40),
  widgets: resilientWidgetArray,
});
export type DashboardTab = z.infer<typeof dashboardTabSchema>;

/**
 * Layout v3: tabbed with widget sizing, an explicit default tab, and an
 * optional `mobileTabs` parallel layout. Stored as JSON on
 * `DashboardConfig.layout`. The `parseLayout` helper migrates older shapes:
 *   v1 (legacy flat widget list) → single "Overview" tab
 *   v2 (tabs only, no sizing) → v3 with default-sized widgets
 *
 * `defaultTabId` falls back to the first tab when undefined.
 * `mobileTabs` is optional — if absent, the mobile view derives from the
 * desktop tabs with widgets stretched to full mobile width.
 */
// LAYOUT_VERSION 5 = 96-col resolution + per-widget x/y.
//   v1 (flat list) / v2 / v3 → authored on the 12-col grid → scale ×RESOLUTION
//   v4 → authored on the 48-col grid (RESOLUTION was 4) → scale ×(RESOLUTION/4)
//   v5 → current, no scaling
export const LAYOUT_VERSION = 5 as const;
const V4_RESOLUTION = 4;

export const dashboardLayoutSchema = z.object({
  version: z
    .union([
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ])
    .default(LAYOUT_VERSION),
  defaultTabId: z.string().optional(),
  tabs: z.array(dashboardTabSchema).default([]),
  mobileTabs: z.array(dashboardTabSchema).optional(),
  // Optional dashboard-exclusive theme (a built-in theme id). When set, the
  // shared (/share/[token]) view renders in this palette regardless of the
  // viewer's personal theme. Stored as a plain string and validated against
  // the theme catalogue where it's applied (keeps this module decoupled from
  // the theme list). Absent = use the viewer's own theme.
  theme: z.string().optional(),
});
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

const legacyLayoutSchema = z.object({
  widgets: z.array(widgetInstanceSchema).default([]),
});

// Scale a tab's widget geometry by `factor`. Pre-v4 layouts have no x/y;
// v4 layouts do, so position is scaled too.
const scaleTabBy =
  (factor: number, scalePosition: boolean) =>
  (t: DashboardTab): DashboardTab => ({
    ...t,
    widgets: t.widgets.map((w) => ({
      ...w,
      cols: Math.min(
        MAX_WIDGET_COLS,
        Math.max(1, Math.round((w.cols ?? 4) * factor)),
      ),
      rows: Math.min(
        MAX_WIDGET_ROWS,
        Math.max(1, Math.round((w.rows ?? 2) * factor)),
      ),
      x:
        scalePosition && typeof w.x === "number"
          ? Math.round(w.x * factor)
          : undefined,
      y:
        scalePosition && typeof w.y === "number"
          ? Math.round(w.y * factor)
          : undefined,
    })),
  });

/**
 * Safe parse + migration on read. Always returns a version-5 layout.
 * Unparseable input returns a default-empty single tab.
 */
export const parseLayout = (raw: unknown): DashboardLayout => {
  const parsed = dashboardLayoutSchema.safeParse(raw);
  if (
    parsed.success &&
    Array.isArray(parsed.data.tabs) &&
    parsed.data.tabs.length > 0
  ) {
    if (parsed.data.version === LAYOUT_VERSION) {
      return { ...parsed.data, version: LAYOUT_VERSION };
    }
    // Pick the scale factor + whether to carry positions based on source ver.
    const v4 = parsed.data.version === 4;
    const factor = v4 ? RESOLUTION / V4_RESOLUTION : RESOLUTION;
    const scale = scaleTabBy(factor, v4);
    return {
      version: LAYOUT_VERSION,
      defaultTabId: parsed.data.defaultTabId,
      tabs: parsed.data.tabs.map(scale),
      mobileTabs: parsed.data.mobileTabs?.map(scale),
      theme: parsed.data.theme,
    };
  }
  const v1 = legacyLayoutSchema.safeParse(raw);
  if (v1.success) {
    const scale = scaleTabBy(RESOLUTION, false);
    return {
      version: LAYOUT_VERSION,
      defaultTabId: "overview",
      tabs: [
        scale({ id: "overview", name: "Overview", widgets: v1.data.widgets }),
      ],
    };
  }
  return {
    version: LAYOUT_VERSION,
    defaultTabId: "overview",
    tabs: [{ id: "overview", name: "Overview", widgets: [] }],
  };
};

/**
 * Returns the tab id that should be selected on first render. Prefers
 * `defaultTabId` if it points to an existing tab; otherwise the first tab.
 */
export const resolveDefaultTabId = (layout: DashboardLayout): string => {
  const ids = new Set(layout.tabs.map((t) => t.id));
  if (layout.defaultTabId && ids.has(layout.defaultTabId)) {
    return layout.defaultTabId;
  }
  return layout.tabs[0]?.id ?? "overview";
};

/**
 * Generate a stable id for a new tab. Not meant to be cryptographically
 * unique — just unique within a single dashboard's tabs array.
 */
export const newTabId = (): string =>
  `tab_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Per-widget configuration schemas. Widgets that omit an entry here are
 * "no-config" — the editor surfaces them but does not render a form. To add
 * a new configurable widget: drop a schema below, and the WidgetConfigEditor
 * will pick it up automatically.
 */
export const WIDGET_CONFIG_SCHEMAS: Partial<Record<WidgetType, z.ZodTypeAny>> = {
  character_timeline: z.object({
    characterId: z.string().cuid().optional(),
  }),
};

export type CharacterTimelineConfig = {
  characterId?: string;
};

export const isConfigurable = (type: WidgetType): boolean =>
  WIDGET_CONFIG_SCHEMAS[type] !== undefined;

export const WIDGET_META: Record<
  WidgetType,
  { title: string; description: string }
> = {
  ilvl_roster: {
    title: "Team Roster",
    description:
      "Every active member with roster rank, realm, level and equipped iLvL — sortable by any column.",
  },
  mplus_ladder: {
    title: "Mythic+ ladder",
    description: "Members ranked by current-season M+ rating.",
  },
  vault_progress: {
    title: "Great Vault progress",
    description: "Per-character vault slots filled this reset.",
  },
  raid_completion: {
    title: "Raid completion",
    description: "Boss-kill matrix across the current raid tier and difficulty.",
  },
  tier_set_tracker: {
    title: "Tier-set tracker",
    description: "How many tier pieces each character has equipped.",
  },
  wcl_parses: {
    title: "Warcraft Logs parses",
    description: "Best recent percentiles for the current raid tier.",
  },
  character_timeline: {
    title: "Character timeline",
    description: "iLvL progression over time for a single character.",
  },
  class_composition: {
    title: "Class composition",
    description: "Counts by class + role split (tank / heal / DPS).",
  },
  ilvl_distribution: {
    title: "iLvL distribution",
    description: "Histogram of equipped item levels with min/median/mean/max.",
  },
  missing_fixes: {
    title: "Missing enchants / gems",
    description:
      "Action list of characters lacking enchants or gems, sorted by iLvL.",
  },
  mplus_weekly: {
    title: "M+ this week",
    description:
      "Weekly runs + highest key + vault slots unlocked for each member.",
  },
  talent_loadouts: {
    title: "Talent loadouts",
    description: "Current spec per character — quick off-meta spotcheck.",
  },
  parses_heatmap: {
    title: "Parses heatmap",
    description:
      "Per-character × per-encounter best-percentile heatmap from WCL.",
  },
  recent_kills: {
    title: "Recent kills",
    description: "Boss kills across the team in the last 7 days, newest first.",
  },
  keystones: {
    title: "This week's keystones",
    description:
      "The M+ keystone each member currently holds — for scheduling key night.",
  },
  weekly_lockouts: {
    title: "Weekly lockouts",
    description:
      "Heroic/Mythic bosses each member cleared THIS reset, per raid.",
  },
  upgrade_currencies: {
    title: "Upgrade currencies",
    description:
      "Catalyst charges + crests / valorstones / coffer keys per member.",
  },
  consumable_readiness: {
    title: "Raid consumables",
    description:
      "Flasks / potions / food / weapon enhancements on hand before pull.",
  },
  delve_progress: {
    title: "Delve progress",
    description:
      "Delve season / tier / companion (Valeera) level per member.",
  },
  talent_builds: {
    title: "Talent builds",
    description:
      "Each member's current talent loadout, linked to the calculator.",
  },
  engagement_pulse: {
    title: "Engagement pulse",
    description:
      "Characters × raid-weeks activity heatmap with a multi-signal churn early-warning watchlist.",
  },
  prog_curve: {
    title: "Progression curve",
    description:
      "Pull-by-pull boss progress with trend line + night-pace view, from the guild's public WCL logs.",
  },
  parse_consistency: {
    title: "Parse consistency",
    description:
      "Median vs best percentile, per-kill variance, and week-over-week improvement vs the roster.",
  },
  professions: {
    title: "Professions",
    description:
      "Each member's primary + secondary professions, current-tier skill, and known-recipe count — with a who-can-craft-X pivot.",
  },
  first_death_ledger: {
    title: "First-death ledger",
    description:
      "Who starts the wipes — per-boss first-death and early-death rates, deaths/pull, and killing ability, from the guild's public WCL logs.",
  },
  attendance_ledger: {
    title: "Attendance ledger",
    description:
      "Who actually showed each raid night (observed by the Raid Team Stats addon) next to their calendar signup — with a rolling attendance % and no-show flags.",
  },
  learning_curve: {
    title: "Learning curve",
    description:
      "Per-player mechanic learning rate on a boss — who stops dying early as the team progresses, team-relative, with coaching-candidate flags. From public WCL logs.",
  },
  tonight_ready: {
    title: "Tonight ready",
    description:
      "Pre-raid readiness board — consumables on hand + gear hygiene per player, with a Ready / Needs-attention tally and call-out list.",
  },
  bench_equity: {
    title: "Bench equity",
    description:
      "Per-boss pull participation — who pulls vs who sits, kill presence, and an equity view, from the guild's public WCL logs.",
  },
  brez_economy: {
    title: "Brez economy",
    description:
      "Battle-rez usage on progression — rezzes per boss + per pull, success rate, who provides vs needs them. From public WCL logs.",
  },
  cooldown_usage: {
    title: "Defensive usage",
    description:
      "Did the dying player have a personal defensive up? Per-player defensive coverage on the wipes that killed them, plus which mechanics the team eats raw. From public WCL logs.",
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Add-widget picker: category grouping + per-widget info content.
// Both are Record<WidgetType, …> so a new widget can't ship without being
// categorized and documented (tsc fails otherwise).
// ──────────────────────────────────────────────────────────────────────────────

export type WidgetCategoryId =
  | "roster"
  | "gear"
  | "progression"
  | "mplus"
  | "coaching"
  | "engagement";

/** Categories in display (left→right column) order. */
export const WIDGET_CATEGORIES: ReadonlyArray<{
  id: WidgetCategoryId;
  label: string;
}> = [
  { id: "roster", label: "Roster & Identity" },
  { id: "gear", label: "Gear & Readiness" },
  { id: "progression", label: "Raid Progression & Parses" },
  { id: "mplus", label: "Mythic+ & Vault" },
  { id: "coaching", label: "Coaching & Deaths" },
  { id: "engagement", label: "Engagement & Utility" },
];

/** Each widget's single closest-fit category (drives the picker columns). */
export const WIDGET_CATEGORY: Record<WidgetType, WidgetCategoryId> = {
  ilvl_roster: "roster",
  class_composition: "roster",
  talent_loadouts: "roster",
  talent_builds: "roster",
  professions: "roster",
  ilvl_distribution: "gear",
  character_timeline: "gear",
  tier_set_tracker: "gear",
  missing_fixes: "gear",
  consumable_readiness: "gear",
  tonight_ready: "gear",
  raid_completion: "progression",
  recent_kills: "progression",
  wcl_parses: "progression",
  parses_heatmap: "progression",
  prog_curve: "progression",
  parse_consistency: "progression",
  mplus_ladder: "mplus",
  mplus_weekly: "mplus",
  keystones: "mplus",
  weekly_lockouts: "mplus",
  vault_progress: "mplus",
  first_death_ledger: "coaching",
  learning_curve: "coaching",
  cooldown_usage: "coaching",
  brez_economy: "coaching",
  bench_equity: "coaching",
  attendance_ledger: "engagement",
  engagement_pulse: "engagement",
  upgrade_currencies: "engagement",
  delve_progress: "engagement",
};

/** User-facing info for the picker's per-widget detail lightbox. */
export type WidgetInfo = {
  /** What it tracks. */
  tracks: string;
  /** How the data is displayed. */
  displayed: string;
  /** How to interpret it. */
  interpret: string;
  /** Cautions / confounders / limitations. */
  cautions: string;
};

export const WIDGET_INFO: Record<WidgetType, WidgetInfo> = {
  ilvl_roster: {
    tracks: "Every active member with roster rank, realm, level, and equipped item level.",
    displayed: "A sortable table — click any column header to sort (ranks sort by standing, not alphabetically).",
    interpret: "Your roster and gear floor at a glance; sort by iLvL to find your weakest-geared mains.",
    cautions: "iLvL prefers the addon's equipment scan and falls back to Blizzard's summary, so a member without the addon may show a slightly stale number.",
  },
  mplus_ladder: {
    tracks: "Each member's current-season Mythic+ rating, with per-role scores and this week's highest timed key.",
    displayed: "A leaderboard ranked high-to-low, score color-coded by tier, with role scores (T/H/D) when scored.",
    interpret: "Find your strongest M+ players for key night; role scores reveal who's practiced in an off-role.",
    cautions: "Uses Raider.IO's 'all' rating (Blizzard rating only if RIO is unavailable); it lags a fresh run until the next sync.",
  },
  vault_progress: {
    tracks: "How many Great Vault slots each character has unlocked this reset across Raid, M+, and World/Delve.",
    displayed: "A per-character pip matrix; filled pips are unlocked slots, colored by gear track.",
    interpret: "Spot who still owes vault progress before reset to maximise loot.",
    cautions: "Raid and M+ come from Blizzard, but the World (Delve) row is addon-only — no Blizzard API exposes it; without the addon that row reads as unavailable.",
  },
  raid_completion: {
    tracks: "Boss kills by difficulty in the current lockout (since Tuesday reset), plus the season-cumulative total.",
    displayed: "A per-member list: this-week kills by difficulty on top, season total muted below.",
    interpret: "Confirm who got their kills this reset and verify long-term tier progress.",
    cautions: "This-lockout counts exclude any kill with a missing timestamp, so a member can be slightly undercounted.",
  },
  tier_set_tracker: {
    tracks: "Which of the five tier-set slots each character has equipped, and each piece's gear track.",
    displayed: "A character × slot matrix of colored pips (filled = equipped, color = gear track).",
    interpret: "See who's chasing which tier slots to prioritise loot and catalyst charges.",
    cautions: "Tier data is addon-only (no Blizzard API exposes per-slot tier); a member without the addon shows blank.",
  },
  wcl_parses: {
    tracks: "Each member's best Mythic DPS percentile for the current tier, toggleable between this lockout and the season.",
    displayed: "A sortable table (best %, bosses parsed, data age) with a Week / Season toggle.",
    interpret: "Identify your top performers and how fresh their logs are; 'This week' reflects current form.",
    cautions: "DPS-percentile only (less meaningful for tanks/healers) and pinned to the current raid zone; percentiles can reset on a new WCL partition.",
  },
  character_timeline: {
    tracks: "A single character's equipped item level over the last 60 days.",
    displayed: "A small sparkline trend line (pure shape, no axes or labels).",
    interpret: "Spot a stalled gearer (flat line) vs steady progression (rising line).",
    cautions: "Needs at least two snapshots to draw a line; it's a trend shape, not exact iLvL values.",
  },
  class_composition: {
    tracks: "How many of each class are on the roster and the tank/heal/DPS split.",
    displayed: "Three count cards plus a class-distribution bar (class-colored), with an expandable roster list.",
    interpret: "Check comp balance and class-stacking to plan recruitment or buff coverage.",
    cautions: "Roles are inferred from each member's latest spec, so a stale or off-spec snapshot can misclassify a player.",
  },
  ilvl_distribution: {
    tracks: "The spread of equipped item levels across the team, with min/mean/max.",
    displayed: "A histogram bucketed by iLvL range, with summary stat cards.",
    interpret: "See your gear curve and spot under-geared outliers at the low end.",
    cautions: "Bars above the expansion's max-iLvL cap are flagged as a likely data anomaly, not a real outlier.",
  },
  missing_fixes: {
    tracks: "Which characters are missing enchants or gems, and on exactly which slots.",
    displayed: "A worst-first table with red/green gear icons (hover for the missing slots) and a detail lightbox.",
    interpret: "A pre-raid action list — fix the red icons before pull, sorted by urgency.",
    cautions: "The enchant/gem audit is addon-only (no Blizzard API), so members without the addon won't appear.",
  },
  mplus_weekly: {
    tracks: "Each member's M+ run count this week and the highest key they've timed.",
    displayed: "A table sorted by run count, descending.",
    interpret: "Confirm everyone hit their weekly M+ quota; spot who hasn't run keys.",
    cautions: "Run count is from the Blizzard snapshot and can lag a just-finished run.",
  },
  talent_loadouts: {
    tracks: "The current spec each member is playing.",
    displayed: "A table of Character / Class / Spec, sorted by spec.",
    interpret: "A quick off-meta spotcheck — see who's on which spec before assignments.",
    cautions: "Reflects the latest sync, so a very recent respec may not show until the next refresh.",
  },
  parses_heatmap: {
    tracks: "Each member's best percentile on every encounter in the current raid tier.",
    displayed: "A character × encounter heatmap colored by percentile, with per-kill history on click and a week/season toggle.",
    interpret: "Spot at a glance which players are weak on which specific bosses for targeted coaching.",
    cautions: "Shows only the current raid tier and is a DPS-percentile view.",
  },
  recent_kills: {
    tracks: "Boss kills across the whole team in the last 7 days.",
    displayed: "A time-sorted feed (newest first) with character, boss, raid, difficulty, and relative time.",
    interpret: "A quick pulse of recent raid activity and what's been clearing.",
    cautions: "Fixed 7-day window; alts/cross-realm kills only appear if that character is tracked.",
  },
  keystones: {
    tracks: "The actual Mythic+ keystone each member is currently holding.",
    displayed: "A table sorted by keystone level, highest first.",
    interpret: "Plan key night around who holds what — the only way to see held (not completed) keys.",
    cautions: "Addon-only: Blizzard and Raider.IO only expose completed runs, never the held keystone.",
  },
  weekly_lockouts: {
    tracks: "Which Heroic/Mythic bosses each member has cleared this reset, per raid.",
    displayed: "A table with per-raid columns showing killed/total and an extend marker.",
    interpret: "Spot lockout imbalances and who's saved where before forming a group.",
    cautions: "Addon-only — the Blizzard web API only exposes season aggregates, not the live weekly lockout.",
  },
  upgrade_currencies: {
    tracks: "Each member's catalyst charges and upgrade/seasonal currencies (crests, valorstones, coffer keys, sparks).",
    displayed: "A per-character table listing currency name and quantity.",
    interpret: "Spot who's capped or sitting on crests so they spend before reset.",
    cautions: "Addon-only (none of this is on any external API); members without the addon show nothing.",
  },
  consumable_readiness: {
    tracks: "Whether each member has flasks, potions, food, and weapon enhancements on hand.",
    displayed: "A table with Flask / Pots / Food / Wpn columns (green count or red ✗); hover for item detail.",
    interpret: "A pre-raid checklist — confirm everyone is stocked before pulling.",
    cautions: "Reads bag contents via the addon only; a member without the addon or a recent scan shows no data.",
  },
  delve_progress: {
    tracks: "Each member's delve season, tier, and companion (Brann/Valeera) level.",
    displayed: "A table of Character / Season / Tier / Companion.",
    interpret: "Coordinate delving and see who's progressed their companion.",
    cautions: "Addon-only and brittle (the delve API shifts across patches); shows whatever the live client exposed.",
  },
  talent_builds: {
    tracks: "Each member's current talent loadout, with a one-click link to the build.",
    displayed: "A table with a 'View build ↗' link to the Wowhead calculator per character.",
    interpret: "Audit builds against the calculator without asking members to export anything.",
    cautions: "Sourced from Blizzard's /specializations (the addon can't read the loadout on 12.0); falls back to an import string on older uploads.",
  },
  engagement_pulse: {
    tracks: "Each player's weekly activity as a 0–100 weighted 'Pulse' index, plus a churn-risk watchlist.",
    displayed: "A multi-line trend chart per player (dots = observed weeks) with a flagged-members watchlist and per-player concern explanations.",
    interpret: "An early warning that someone may be disengaging — a falling line is a prompt to check in.",
    cautions: "Measures activity, not attendance — unobserved weeks are gaps not zeros, the in-progress week is excluded, and signals are conversation starters, not conclusions.",
  },
  prog_curve: {
    tracks: "Pull-by-pull boss progress on progression bosses, plus a per-night pacing timeline.",
    displayed: "Two tabs: a pull scatter with a rolling-best/trend line, and a per-night timeline with break bands.",
    interpret: "See whether the team is trending toward a kill and whether late-night pulls decay.",
    cautions: "From public WCL logs (no WCL points spent); pace is descriptive — farm vs prog nights read differently and samples are small.",
  },
  parse_consistency: {
    tracks: "Each player's median vs best percentile, per-kill variance (σ), and week-over-week trend relative to the roster.",
    displayed: "Two tabs: a median/best bar table, and a week-over-week relative-trend sparkline view.",
    interpret: "A high best with a low median is inconsistency, not a skill shortage — coach the median, not the best-ever parse.",
    cautions: "σ needs ≥4 logged kills (low-sample rows greyed); percentiles reset on a new partition; healer/tank rows are context, not ranking.",
  },
  professions: {
    tracks: "Each member's primary/secondary professions, current-tier skill, and known-recipe count, with a who-can-craft pivot.",
    displayed: "Two views — by character and by profession (crafter pivot) — with a searchable recipe lightbox.",
    interpret: "Find who can craft/enchant what and where your profession coverage has gaps.",
    cautions: "Shows accurate scope only — no fabricated coverage % or guessed lists; only recipes the character actually has are listed.",
  },
  first_death_ledger: {
    tracks: "Per boss, who dies first/early in wipes, deaths-per-pull, and the ability that landed the killing blow.",
    displayed: "A player table ranked by first-death rate, with an expandable death-time histogram per player.",
    interpret: "'Who died first is almost always the most important death' — find who's repeatedly initiating wipes.",
    cautions: "Needs ≥5 logged wipes on a boss; the killing ability lies (tiny ticking DoTs land the blow), so it's context, never the headline.",
  },
  attendance_ledger: {
    tracks: "Who was actually observed present each raid night vs their calendar signup, with a rolling attendance %.",
    displayed: "A character × raid-night grid (present/late/left/absent/unobserved glyphs) with a no-show ring and a % column.",
    interpret: "Makes 'signed up but didn't show' obvious and tracks reliability over time.",
    cautions: "Presence is addon-observed (unobserved nights are grey, not absent); the rolling % needs 3+ observed nights to appear.",
  },
  learning_curve: {
    tracks: "Per player per boss, whether they stop dying early as the team progresses, normalised against the team's overall improvement.",
    displayed: "A table with a trend badge (improving/flat/regressing), early-death %, survival time, and coaching-candidate flags.",
    interpret: "Flags players improving slower than the team and still dying early — your targeted-coaching shortlist.",
    cautions: "Deaths-based with no duty context — sanity-check an assigned soak, kite, or tank death before coaching; team-normalised so 'the boss got harder' doesn't read as one player stalling.",
  },
  tonight_ready: {
    tracks: "A pre-raid readiness board: consumables on hand plus gear hygiene (enchants/gems) per player.",
    displayed: "A Ready / Needs-attention / Unknown tally with a per-player two-pillar table and a callout list.",
    interpret: "One glance before pull tells you who's ready and exactly who needs what.",
    cautions: "Consumables need the addon and go 'unknown' if the bag scan is stale; gear hygiene is always available from Blizzard.",
  },
  bench_equity: {
    tracks: "Per-boss pull participation — who's pulling vs who's sitting, and kill presence.",
    displayed: "A per-player participation bar plus a per-boss matrix (pulls-in/total, ✓ for kill presence), with a difficulty dropdown.",
    interpret: "Lower participation = sat/benched more — surface bench imbalance for fairness conversations.",
    cautions: "From public WCL logs; low participation can also just mean a recently-joined member, not a benching decision.",
  },
  brez_economy: {
    tracks: "Battle-rez usage on progression — rezzes per boss and per pull, success rate, and who provides vs needs them.",
    displayed: "Header tallies, a per-boss table, and two leaderboards (top providers / most-rezzed).",
    interpret: "See if brezzes are spent efficiently — survived = the rez landed and the target didn't die again that pull.",
    cautions: "From public WCL logs; a low success rate often reflects doomed pulls (wipe incoming) rather than bad brez decisions.",
  },
  cooldown_usage: {
    tracks: "Whether the dying player had a personal defensive up on the hits that killed them, plus which mechanics the team eats raw.",
    displayed: "An overall coverage %, a per-player table (deaths, covered, coverage bar), and a top-uncovered-mechanics list.",
    interpret: "A 'where to look' signal for who isn't pressing defensives on lethal hits.",
    cautions: "A low coverage % is NOT automatically bad — some deaths no defensive would save, and some roles intentionally hold CDs; only ranks players with ≥3 deaths.",
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Add-widget picker: per-widget reliance on the Raid Team Stats addon/companion.
//   "all"     — every field comes from the addon export; no addon = blank widget.
//   "partial" — some fields are addon-only, the rest from Blizzard/WCL.
//   "none"    — fully served by Blizzard / Raider.IO / WCL; the addon is optional.
// Record<WidgetType, …> so a new widget can't ship without declaring this
// (tsc fails otherwise). Each entry is justified by that widget's `cautions`
// prose in WIDGET_INFO above.
// ──────────────────────────────────────────────────────────────────────────────
export type AddonDependence = "none" | "partial" | "all";

export const WIDGET_ADDON_DEPENDENCE: Record<WidgetType, AddonDependence> = {
  ilvl_roster: "none",
  mplus_ladder: "none",
  vault_progress: "partial",
  raid_completion: "none",
  tier_set_tracker: "all",
  wcl_parses: "none",
  character_timeline: "none",
  class_composition: "none",
  ilvl_distribution: "none",
  missing_fixes: "all",
  mplus_weekly: "none",
  talent_loadouts: "none",
  parses_heatmap: "none",
  recent_kills: "none",
  keystones: "all",
  weekly_lockouts: "all",
  upgrade_currencies: "all",
  consumable_readiness: "all",
  delve_progress: "all",
  talent_builds: "none",
  engagement_pulse: "partial",
  prog_curve: "none",
  parse_consistency: "none",
  professions: "none",
  first_death_ledger: "none",
  attendance_ledger: "all",
  learning_curve: "none",
  tonight_ready: "partial",
  bench_equity: "none",
  brez_economy: "none",
  cooldown_usage: "none",
};
