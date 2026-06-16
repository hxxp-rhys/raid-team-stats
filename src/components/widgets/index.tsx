"use client";

import type { ComponentType } from "react";

import type { WidgetInstance, WidgetType } from "@/lib/widgets/types";
import { CharacterTimelineWidget } from "./character-timeline";
import { ClassCompositionWidget } from "./class-composition";
import { ConsumableReadinessWidget } from "./consumable-readiness";
import { DataRefreshWidget } from "./data-refresh";
import { DelveProgressWidget } from "./delve-progress";
import { AttendanceLedgerWidget } from "./attendance-ledger";
import { BenchEquityWidget } from "./bench-equity";
import { BrezEconomyWidget } from "./brez-economy";
import { CooldownUsageWidget } from "./cooldown-usage";
import { EngagementPulseWidget } from "./engagement-pulse";
import { FirstDeathLedgerWidget } from "./first-death-ledger";
import { LearningCurveWidget } from "./learning-curve";
import { TonightReadyWidget } from "./tonight-ready";
import { IlvlDistributionWidget } from "./ilvl-distribution";
import { IlvlRosterWidget } from "./ilvl-roster";
import { KeystonesWidget } from "./keystones";
import { MissingFixesWidget } from "./missing-fixes";
import { MplusLadderWidget } from "./mplus-ladder";
import { MplusWeeklyWidget } from "./mplus-weekly";
import { ParseConsistencyWidget } from "./parse-consistency";
import { ParsesHeatmapWidget } from "./parses-heatmap";
import { ProfessionsWidget } from "./professions";
import { ProgCurveWidget } from "./prog-curve";
import { RaidCompletionWidget } from "./raid-completion";
import { RecentKillsWidget } from "./recent-kills";
import { TalentBuildsWidget } from "./talent-builds";
import { TalentLoadoutsWidget } from "./talent-loadouts";
import { TierSetTrackerWidget } from "./tier-set-tracker";
import { UpgradeCurrenciesWidget } from "./upgrade-currencies";
import { VaultDetailWidget } from "./vault-detail";
import { VaultProgressWidget } from "./vault-progress";
import { WclParsesWidget } from "./wcl-parses";
import { WeeklyLockoutsWidget } from "./weekly-lockouts";

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
  raid_completion: RaidCompletionWidget,
  tier_set_tracker: TierSetTrackerWidget,
  wcl_parses: WclParsesWidget,
  character_timeline: TimelineHost,
  class_composition: ClassCompositionWidget,
  ilvl_distribution: IlvlDistributionWidget,
  missing_fixes: MissingFixesWidget,
  mplus_weekly: MplusWeeklyWidget,
  talent_loadouts: TalentLoadoutsWidget,
  parses_heatmap: ParsesHeatmapWidget,
  recent_kills: RecentKillsWidget,
  vault_detail: VaultDetailWidget,
  keystones: KeystonesWidget,
  weekly_lockouts: WeeklyLockoutsWidget,
  upgrade_currencies: UpgradeCurrenciesWidget,
  consumable_readiness: ConsumableReadinessWidget,
  delve_progress: DelveProgressWidget,
  talent_builds: TalentBuildsWidget,
  data_refresh: DataRefreshWidget,
  engagement_pulse: EngagementPulseWidget,
  prog_curve: ProgCurveWidget,
  parse_consistency: ParseConsistencyWidget,
  professions: ProfessionsWidget,
  first_death_ledger: FirstDeathLedgerWidget,
  attendance_ledger: AttendanceLedgerWidget,
  learning_curve: LearningCurveWidget,
  tonight_ready: TonightReadyWidget,
  bench_equity: BenchEquityWidget,
  brez_economy: BrezEconomyWidget,
  cooldown_usage: CooldownUsageWidget,
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
