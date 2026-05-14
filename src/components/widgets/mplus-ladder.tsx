"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

export function MplusLadderWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Mythic+ ladder"
      description="Current-season rating per character, descending."
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        <ol className="space-y-1 text-sm">
          {[...q.data.members]
            .map((m) => ({
              name: m.character.name,
              realm: m.character.realmSlug,
              rating: m.latest.mplus?.currentRating
                ? Number(m.latest.mplus.currentRating)
                : null,
              weeklyHighest: m.latest.mplus?.weeklyHighest ?? null,
            }))
            .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1))
            .map((row, i) => (
              <li
                key={`${row.name}-${row.realm}`}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="flex items-baseline gap-2">
                  <span className="text-muted-foreground w-5 text-right text-xs">
                    {i + 1}.
                  </span>
                  <span className="font-medium">{row.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {row.realm}
                  </span>
                </span>
                <span className="font-mono">
                  {row.rating?.toFixed(0) ?? "—"}
                  {row.weeklyHighest != null && (
                    <span className="text-muted-foreground ml-2 text-xs">
                      +{row.weeklyHighest}
                    </span>
                  )}
                </span>
              </li>
            ))}
        </ol>
      )}
    </WidgetShell>
  );
}
