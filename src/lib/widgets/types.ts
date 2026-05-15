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
  "gear_audit",
  "raid_completion",
  "tier_set_tracker",
  "wcl_parses",
  "character_timeline",
  "roster_freshness",
  "class_composition",
  "ilvl_distribution",
  "missing_fixes",
  "mplus_weekly",
  "talent_loadouts",
  "parses_heatmap",
  "recent_kills",
] as const;

export type WidgetType = (typeof WIDGET_TYPES)[number];

const widgetTypeSchema = z.enum(WIDGET_TYPES);

export const widgetInstanceSchema = z.object({
  id: z.string().min(1),
  type: widgetTypeSchema,
  config: z.record(z.string(), z.unknown()).optional(),
});
export type WidgetInstance = z.infer<typeof widgetInstanceSchema>;

/**
 * A named tab grouping widgets together. Dashboards may have one or many
 * tabs; the editor lets owners reorder + rename tabs and move widgets
 * between them.
 */
export const dashboardTabSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(40),
  widgets: z.array(widgetInstanceSchema).default([]),
});
export type DashboardTab = z.infer<typeof dashboardTabSchema>;

/**
 * Layout v2: tabbed. Stored as JSON on `DashboardConfig.layout`. Backward
 * compatible with v1 (the `parseLayout` helper migrates old `{ widgets: [...] }`
 * into a single "Overview" tab on read).
 */
export const dashboardLayoutSchema = z.object({
  version: z.literal(2).default(2),
  tabs: z.array(dashboardTabSchema).default([]),
});
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

const legacyLayoutSchema = z.object({
  widgets: z.array(widgetInstanceSchema).default([]),
});

/**
 * Safe parse with v1-→-v2 migration on read. Old dashboards (single flat
 * widget array) are returned as a single "Overview" tab. Unparseable input
 * returns a default-empty single tab so the page never crashes.
 */
export const parseLayout = (raw: unknown): DashboardLayout => {
  const v2 = dashboardLayoutSchema.safeParse(raw);
  if (v2.success && Array.isArray(v2.data.tabs) && v2.data.tabs.length > 0) {
    return v2.data;
  }
  const v1 = legacyLayoutSchema.safeParse(raw);
  if (v1.success) {
    return {
      version: 2,
      tabs: [{ id: "overview", name: "Overview", widgets: v1.data.widgets }],
    };
  }
  return {
    version: 2,
    tabs: [{ id: "overview", name: "Overview", widgets: [] }],
  };
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
  gear_audit: {
    title: "Gear audit",
    description: "Missing enchants and gems, flagged per character.",
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
  roster_freshness: {
    title: "Roster freshness",
    description: "When each character was last synced from Battle.net.",
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
};
