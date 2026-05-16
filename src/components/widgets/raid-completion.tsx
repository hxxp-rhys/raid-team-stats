"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Snapshot shape: array of per-instance / per-mode completion entries
 * emitted by tracked-member-sync.ts after the spec+raid extension. Each
 * entry's `encounters` carries the per-boss kill count + the last-kill
 * timestamp (used to scope the widget to the current weekly lockout).
 */
type CompletionEntry = {
  instanceId?: number | null;
  instanceName?: string | null;
  difficultyType?: string | null;
  completedCount?: number;
  totalCount?: number;
  encounters?: Array<{
    id?: number | null;
    name?: string | null;
    kills?: number;
    lastKillTimestamp?: number | null;
  }>;
};

/**
 * Start (epoch ms) of the current weekly lockout. The raid week runs
 * Tuesday 12:00 (noon) → the following Tuesday 11:00, with 11:00–12:00 the
 * reset/maintenance gap. So "this week" = at/after the most recent Tuesday
 * noon. Computed in the viewer's local time per the product definition.
 *
 * If now is a Tuesday before noon (incl. the 11:00–12:00 gap), the current
 * week is still the *previous* Tuesday's — step back a week.
 */
function currentWeekStartMs(now: number): number {
  const d = new Date(now);
  const daysSinceTue = (d.getDay() - 2 + 7) % 7; // Tue=2; 0 when today is Tue
  const tue = new Date(d);
  tue.setDate(d.getDate() - daysSinceTue);
  tue.setHours(12, 0, 0, 0); // Tuesday 12:00 noon, local
  if (tue.getTime() > now) tue.setDate(tue.getDate() - 7);
  return tue.getTime();
}

// Canonical difficulty labels. Blizzard reports both "LFR" and
// "RAID_FINDER" for Looking-For-Raid; both fold to "LFR". The label is the
// short form shown in the widget; `full` is the hover tooltip.
const DIFF_LABEL: Record<string, { label: string; full: string }> = {
  MYTHIC: { label: "Mythic", full: "Mythic" },
  HEROIC: { label: "Heroic", full: "Heroic" },
  NORMAL: { label: "Normal", full: "Normal" },
  LFR: { label: "LFR", full: "Looking For Raid" },
  RAID_FINDER: { label: "LFR", full: "Looking For Raid" },
};
const DIFF_ORDER = ["MYTHIC", "HEROIC", "NORMAL", "LFR"];

const normalizeDiff = (d: string): string =>
  d.toUpperCase() === "RAID_FINDER" ? "LFR" : d.toUpperCase();

export function RaidCompletionWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });
  // Capture "now" once at mount (lazy initializer) so the render stays pure
  // — Date.now() during render trips react-hooks/purity in React 19.
  const [weekStart] = useState(() => currentWeekStartMs(Date.now()));

  return (
    <WidgetShell
      title="Raid completion"
      description="Boss kills by difficulty this lockout (since Tuesday reset)."
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        <ul className="divide-border divide-y text-sm">
          {q.data.members.map((m) => {
            const entries =
              (m.latest.raid?.completions as CompletionEntry[] | null) ?? [];
            const byDiff: Record<string, number> = {};
            for (const e of entries) {
              if (!e.difficultyType) continue;
              const diff = normalizeDiff(e.difficultyType);
              // Only bosses killed in the CURRENT lockout: a valid
              // lastKillTimestamp at/after this week's Tuesday-noon start.
              // Missing timestamp → can't prove it's this week → exclude.
              const killed = (e.encounters ?? []).filter(
                (b) =>
                  (b.kills ?? 0) > 0 &&
                  typeof b.lastKillTimestamp === "number" &&
                  b.lastKillTimestamp >= weekStart,
              ).length;
              if (killed === 0) continue;
              byDiff[diff] = Math.max(byDiff[diff] ?? 0, killed);
            }
            return (
              <li
                key={m.character.id}
                className="flex items-baseline justify-between py-1.5"
              >
                <span className="font-medium">{m.character.name}</span>
                <span className="text-muted-foreground flex gap-3 text-xs">
                  {DIFF_ORDER.filter((d) => byDiff[d]).map((d) => (
                    <span key={d} title={DIFF_LABEL[d]?.full}>
                      <span className="font-medium">
                        {DIFF_LABEL[d]?.label ?? d}
                      </span>{" "}
                      <span className="font-mono">{byDiff[d]}</span>
                    </span>
                  ))}
                  {Object.keys(byDiff).length === 0 && <span>—</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetShell>
  );
}
