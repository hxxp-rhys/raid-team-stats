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
  "data_refresh",
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
  data_refresh: { cols: 4, rows: 2 },
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
    title: "Item-level roster",
    description: "Sortable table of every active member's current equipped iLvL.",
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
  data_refresh: {
    title: "Data refresh",
    description:
      "On-demand Tier-A refresh + recurring schedule. Raid leaders configure who can trigger it.",
  },
};
