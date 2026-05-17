"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

// Raider.IO season-score breakdown: { all, dps, healer, tank, spec_N… }.
type RioScore = Record<string, number> | null | undefined;

// RIO colour bands (approx. current-season tiers) — purely cosmetic accent.
function scoreClass(score: number | null): string {
  if (score == null) return "text-muted-foreground";
  if (score >= 3500) return "text-orange-400"; // legend
  if (score >= 3000) return "text-purple-400"; // elite
  if (score >= 2500) return "text-pink-400";
  if (score >= 2000) return "text-blue-400";
  if (score >= 1000) return "text-green-400";
  return "text-foreground";
}

const ROLE_KEYS: Array<{ key: string; label: string }> = [
  { key: "tank", label: "T" },
  { key: "healer", label: "H" },
  { key: "dps", label: "D" },
];

export function MplusLadderWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Mythic+ ladder"
      description="Raider.IO current-season score per character, descending. Role splits (T/H/D) shown when scored. +N is the highest key timed this week."
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
            .map((m) => {
              const rio = m.latest.mplus?.rioScore as RioScore;
              // `currentRating` already prefers the RIO "all" score (with a
              // Blizzard-rating fallback when RIO is unavailable).
              const rating = m.latest.mplus?.currentRating
                ? Number(m.latest.mplus.currentRating)
                : null;
              const roles = ROLE_KEYS.map((r) => ({
                label: r.label,
                value: rio?.[r.key] ?? 0,
              })).filter((r) => r.value > 0);
              return {
                name: m.character.name,
                realm: m.character.realmSlug,
                rating,
                roles,
                weeklyHighest: m.latest.mplus?.weeklyHighest ?? null,
              };
            })
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
                <span className="flex items-baseline gap-2">
                  {row.roles.length > 1 &&
                    row.roles.map((r) => (
                      <span
                        key={r.label}
                        title={`${r.label} score`}
                        className="text-muted-foreground font-mono text-[10px]"
                      >
                        {r.label}
                        {r.value.toFixed(0)}
                      </span>
                    ))}
                  <span className={`font-mono ${scoreClass(row.rating)}`}>
                    {row.rating?.toFixed(0) ?? "—"}
                  </span>
                  {row.weeklyHighest != null && (
                    <span className="text-muted-foreground text-xs">
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
