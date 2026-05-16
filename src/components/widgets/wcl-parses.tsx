"use client";

import { useState } from "react";

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

// WCL numeric raid difficulty → label.
const WCL_DIFF: Record<number, string> = {
  1: "LFR",
  3: "Normal",
  4: "Heroic",
  5: "Mythic",
};

function relativeAge(fromMs: number, nowMs: number): string {
  const diff = nowMs - fromMs;
  if (diff < 0) return "just now";
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export function WclParsesWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });
  // Capture "now" once at mount so render stays pure (Date.now() in render
  // trips react-hooks/purity in React 19).
  const [nowMs] = useState(() => Date.now());

  return (
    <WidgetShell
      title="Warcraft Logs parses"
      description="Best DPS percentile per character on the current Midnight raid. Bosses = encounters with a ranked log; Tier = the raid difficulty those logs are from; Age = time since the last WCL sync."
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">
            Best Warcraft Logs percentile per character
          </caption>
          <thead>
            <tr className="text-muted-foreground text-left text-xs uppercase">
              <th scope="col" className="py-1 pr-3 font-medium">Character</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Best %</th>
              <th scope="col" className="py-1 pr-3 font-medium">Tier</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Bosses</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Data age</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {q.data.members.map((m) => {
              const parses = m.latest.wclParses ?? [];
              const ranked = parses.filter(
                (p) => typeof p.percentile === "number",
              );
              const best = ranked.reduce<
                | { percentile: number; encounterName: string | null }
                | null
              >(
                (acc, p) =>
                  acc === null || (p.percentile ?? 0) > acc.percentile
                    ? {
                        percentile: p.percentile ?? 0,
                        encounterName: p.encounterName ?? null,
                      }
                    : acc,
                null,
              );
              // Bosses = distinct encounters with a ranked parse.
              const bossesParsed = new Set(ranked.map((p) => p.encounterId))
                .size;
              // Tier = the difficulty most of this char's ranked logs use
              // (zoneRankings returns one difficulty; take the modal value).
              const diffCounts = new Map<number, number>();
              for (const p of ranked) {
                if (typeof p.difficulty === "number")
                  diffCounts.set(
                    p.difficulty,
                    (diffCounts.get(p.difficulty) ?? 0) + 1,
                  );
              }
              const tierDiff = [...diffCounts.entries()].sort(
                (a, b) => b[1] - a[1],
              )[0]?.[0];
              const tierLabel =
                tierDiff != null ? (WCL_DIFF[tierDiff] ?? `D${tierDiff}`) : "—";
              // Data age = newest capturedAt across this char's parse rows.
              const newestCaptured = parses.reduce<number | null>((acc, p) => {
                const t = p.capturedAt
                  ? new Date(p.capturedAt).getTime()
                  : null;
                return t != null && (acc == null || t > acc) ? t : acc;
              }, null);

              return (
                <tr key={m.character.id}>
                  <td className="py-1.5 pr-3">
                    <span className="font-medium">{m.character.name}</span>
                    {best?.encounterName && (
                      <span className="text-muted-foreground ml-2 text-xs">
                        best: {best.encounterName}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono">
                    {best ? (
                      <span className={percentileColor(best.percentile)}>
                        {best.percentile}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    {best ? (
                      tierLabel
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {bossesParsed > 0 ? bossesParsed : "—"}
                  </td>
                  <td className="text-muted-foreground py-1.5 pr-3 text-right text-xs">
                    {newestCaptured != null
                      ? relativeAge(newestCaptured, nowMs)
                      : "never"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </WidgetShell>
  );
}
