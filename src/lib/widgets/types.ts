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
] as const;

export type WidgetType = (typeof WIDGET_TYPES)[number];

const widgetTypeSchema = z.enum(WIDGET_TYPES);

export const widgetInstanceSchema = z.object({
  id: z.string().min(1),
  type: widgetTypeSchema,
  config: z.record(z.string(), z.unknown()).optional(),
});
export type WidgetInstance = z.infer<typeof widgetInstanceSchema>;

export const dashboardLayoutSchema = z.object({
  widgets: z.array(widgetInstanceSchema).default([]),
});
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

/**
 * Safe parse: returns a default-empty layout for null / malformed input
 * so dashboards never break on rendering an old shape.
 */
export const parseLayout = (raw: unknown): DashboardLayout => {
  const result = dashboardLayoutSchema.safeParse(raw);
  return result.success ? result.data : { widgets: [] };
};

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
};
