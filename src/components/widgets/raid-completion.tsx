"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Snapshot shape: array of per-instance / per-mode completion entries
 * emitted by tracked-member-sync.ts after the spec+raid extension. Each
 * entry's `encounters` carries the per-boss kill count.
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
  }>;
};

const DIFF_ORDER = ["MYTHIC", "HEROIC", "NORMAL", "LFR", "RAID_FINDER"];

export function RaidCompletionWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Raid completion"
      description="Boss kills by difficulty across the latest raid tier."
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
              const diff = e.difficultyType;
              if (!diff) continue;
              const killed = (e.encounters ?? []).filter(
                (b) => (b.kills ?? 0) > 0,
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
                <span className="text-muted-foreground flex gap-3 font-mono text-xs">
                  {DIFF_ORDER.filter((d) => byDiff[d]).map((d) => (
                    <span key={d}>
                      {d.slice(0, 1)}: {byDiff[d]}
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
