"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

const TIER_BONUS_THRESHOLDS = [2, 4] as const;

function TierBar({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={
            i < count
              ? TIER_BONUS_THRESHOLDS.includes((i + 1) as 2 | 4)
                ? "bg-amber-400 inline-block size-2 rounded-sm"
                : "bg-primary inline-block size-2 rounded-sm"
              : "border-muted-foreground/40 inline-block size-2 rounded-sm border"
          }
        />
      ))}
    </span>
  );
}

export function TierSetTrackerWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Tier-set tracker"
      description="Equipped tier pieces per character (2pc + 4pc bonuses highlighted)."
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
            const count = m.latest.equipment?.tierSetPiecesCount ?? 0;
            return (
              <li
                key={m.character.id}
                className="flex items-baseline justify-between py-1.5"
              >
                <span className="font-medium">{m.character.name}</span>
                <span className="flex items-baseline gap-3">
                  <TierBar count={count} />
                  <span className="text-muted-foreground font-mono text-xs">
                    {count}/5
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetShell>
  );
}
