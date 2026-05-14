"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

type Completion = {
  bossId?: number;
  bossName?: string;
  difficulty?: string;
  kills?: number;
};

type RaidPayload =
  | { bosses?: Completion[]; [k: string]: unknown }
  | null
  | undefined;

const DIFF_ORDER = ["MYTHIC", "HEROIC", "NORMAL", "RAID_FINDER"];

export function RaidCompletionWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Raid completion"
      description="Per-character boss kills in the current tier."
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
            const payload = m.latest.raid?.completions as RaidPayload;
            const bosses = payload?.bosses ?? [];
            const byDiff: Record<string, number> = {};
            for (const b of bosses) {
              if (!b.difficulty || !(b.kills && b.kills > 0)) continue;
              byDiff[b.difficulty] = (byDiff[b.difficulty] ?? 0) + 1;
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
