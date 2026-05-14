"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

function percentileColor(p: number): string {
  if (p >= 99) return "text-orange-400";
  if (p >= 95) return "text-purple-400";
  if (p >= 75) return "text-blue-400";
  if (p >= 50) return "text-green-400";
  if (p >= 25) return "text-emerald-400";
  return "text-muted-foreground";
}

export function WclParsesWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Warcraft Logs parses"
      description="Best recent percentile per character on the current tier."
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
            const parses = m.latest.wclParses ?? [];
            const best = parses
              .filter((p) => typeof p.percentile === "number")
              .reduce<{ percentile: number; metric: string | null } | null>(
                (acc, p) =>
                  acc === null || (p.percentile ?? 0) > acc.percentile
                    ? { percentile: p.percentile ?? 0, metric: p.metric ?? null }
                    : acc,
                null,
              );
            return (
              <li
                key={m.character.id}
                className="flex items-baseline justify-between py-1.5"
              >
                <span className="font-medium">{m.character.name}</span>
                {best ? (
                  <span className="font-mono text-xs">
                    <span className={percentileColor(best.percentile)}>
                      {best.percentile}
                    </span>
                    {best.metric && (
                      <span className="text-muted-foreground ml-2 uppercase">
                        {best.metric}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">no parses</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </WidgetShell>
  );
}
