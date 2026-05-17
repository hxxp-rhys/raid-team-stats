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

const MYTHIC = 5; // WCL difficulty 5 = Mythic

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

/**
 * Best Mythic DPS percentile per character for the CURRENT raid lockout.
 *
 * The server computes `weekPercentile` + `reportStartTime` from WCL's
 * `encounterRankings` (per-kill ranks scoped to the Tue-reset week — WCL's
 * `zoneRankings` aggregate has no timestamps and can't answer "this week").
 * A character with no Mythic kill this lockout shows "—".
 */
export function WclParsesWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });
  // Capture "now" once at mount so render stays pure (Date.now() in render
  // trips react-hooks/purity in React 19).
  const [nowMs] = useState(() => Date.now());

  return (
    <WidgetShell
      title="Warcraft Logs parses"
      description="Best Mythic DPS percentile this raid lockout only (Tue reset → Tue reset). Bosses = Mythic encounters killed this week with a ranked log; Age = time since that kill's log."
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
            Best current-lockout Mythic Warcraft Logs percentile per character
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
              // Current raid tier (server-resolved zone) + Mythic + a
              // logged kill THIS lockout (server-set weekPercentile).
              const zone = q.data.currentRaidZoneId;
              const parses = (m.latest.wclParses ?? []).filter(
                (p) =>
                  (zone == null || p.zoneId === zone) &&
                  p.difficulty === MYTHIC &&
                  p.weekPercentile != null,
              );
              const best = parses.reduce<
                { pct: number; name: string | null } | null
              >(
                (acc, p) =>
                  acc === null || (p.weekPercentile ?? 0) > acc.pct
                    ? {
                        pct: p.weekPercentile ?? 0,
                        name: p.encounterName ?? null,
                      }
                    : acc,
                null,
              );
              const bosses = new Set(parses.map((p) => p.encounterId)).size;
              const newest = parses.reduce<number | null>((acc, p) => {
                const t = p.reportStartTime
                  ? new Date(p.reportStartTime).getTime()
                  : null;
                return t != null && (acc == null || t > acc) ? t : acc;
              }, null);

              return (
                <tr key={m.character.id}>
                  <td className="py-1.5 pr-3">
                    <span className="font-medium">{m.character.name}</span>
                    {best?.name && (
                      <span className="text-muted-foreground ml-2 text-xs">
                        best: {best.name}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono">
                    {best ? (
                      <span className={percentileColor(best.pct)}>
                        {best.pct}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    {best ? (
                      "Mythic"
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {bosses > 0 ? bosses : "—"}
                  </td>
                  <td className="text-muted-foreground py-1.5 pr-3 text-right text-xs">
                    {newest != null ? relativeAge(newest, nowMs) : "—"}
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
