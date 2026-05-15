"use client";

import type { ComponentType } from "react";

import type { WidgetInstance, WidgetType } from "@/lib/widgets/types";
import { CharacterTimelineWidget } from "./character-timeline";
import { ClassCompositionWidget } from "./class-composition";
import { GearAuditWidget } from "./gear-audit";
import { IlvlDistributionWidget } from "./ilvl-distribution";
import { IlvlRosterWidget } from "./ilvl-roster";
import { MissingFixesWidget } from "./missing-fixes";
import { MplusLadderWidget } from "./mplus-ladder";
import { MplusWeeklyWidget } from "./mplus-weekly";
import { RaidCompletionWidget } from "./raid-completion";
import { RosterFreshnessWidget } from "./roster-freshness";
import { TalentLoadoutsWidget } from "./talent-loadouts";
import { TierSetTrackerWidget } from "./tier-set-tracker";
import { VaultProgressWidget } from "./vault-progress";
import { WclParsesWidget } from "./wcl-parses";

export type WidgetComponentProps = {
  raidTeamId: string;
  /** Per-widget config from `DashboardConfig.layout.widgets[n].config`. */
  config?: Record<string, unknown>;
};

type WidgetComponent = ComponentType<WidgetComponentProps>;

const TimelineHost: WidgetComponent = ({ raidTeamId, config }) => (
  <CharacterTimelineWidget
    raidTeamId={raidTeamId}
    characterId={typeof config?.characterId === "string" ? config.characterId : undefined}
  />
);

export const WIDGET_REGISTRY: Record<WidgetType, WidgetComponent> = {
  ilvl_roster: IlvlRosterWidget,
  mplus_ladder: MplusLadderWidget,
  vault_progress: VaultProgressWidget,
  gear_audit: GearAuditWidget,
  raid_completion: RaidCompletionWidget,
  tier_set_tracker: TierSetTrackerWidget,
  wcl_parses: WclParsesWidget,
  character_timeline: TimelineHost,
  roster_freshness: RosterFreshnessWidget,
  class_composition: ClassCompositionWidget,
  ilvl_distribution: IlvlDistributionWidget,
  missing_fixes: MissingFixesWidget,
  mplus_weekly: MplusWeeklyWidget,
  talent_loadouts: TalentLoadoutsWidget,
};

/**
 * Renders a single widget instance via the registry. Unknown widget types
 * are silently skipped so an old saved layout never blocks dashboard render.
 */
export function WidgetRender({
  instance,
  raidTeamId,
}: {
  instance: WidgetInstance;
  raidTeamId: string;
}) {
  const Component = WIDGET_REGISTRY[instance.type];
  if (!Component) return null;
  return <Component raidTeamId={raidTeamId} config={instance.config} />;
}
