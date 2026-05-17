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

// WCL Mythic raid difficulty.
const MYTHIC = 5;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Start (epoch ms) of the current raid lockout. The raid week runs from
 * Tuesday 11:00 → the following Tuesday 10:59 (local time). If "now" is a
 * Tuesday before 11:00, the current week is still the previous Tuesday's.
 */
function currentWeekStartMs(now: number): number {
  const d = new Date(now);
  const daysSinceTue = (d.getDay() - 2 + 7) % 7; // Tue=2; 0 when today is Tue
  const tue = new Date(d);
  tue.setDate(d.getDate() - daysSinceTue);
  tue.setHours(11, 0, 0, 0); // Tuesday 11:00 local
  if (tue.getTime() > now) tue.setDate(tue.getDate() - 7);
  return tue.getTime();
}

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
  const weekStart = currentWeekStartMs(nowMs);
  const weekEnd = weekStart + WEEK_MS;

  return (
    <WidgetShell
      title="Warcraft Logs parses"
      description="Best DPS percentile on Mythic for the CURRENT raid tier, this lockout only (Tue 11:00 → Tue 10:59). Bosses = Mythic encounters with a ranked log this week; Age = time since that log was recorded."
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
            Best current-week Mythic Warcraft Logs percentile per character
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
              // Current raid tier only (server-resolved zone), Mythic only,
              // and only logs recorded in THIS lockout. A parse with no
              // report timestamp can't be proven to be this week → excluded.
              const zone = q.data.currentRaidZoneId;
              const parses = (m.latest.wclParses ?? []).filter((p) => {
                if (zone != null && p.zoneId !== zone) return false;
                if (p.difficulty !== MYTHIC) return false;
                if (!p.reportStartTime) return false;
                const t = new Date(p.reportStartTime).getTime();
                return t >= weekStart && t < weekEnd;
              });
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
              const bossesParsed = new Set(ranked.map((p) => p.encounterId))
                .size;
              const tierLabel = best ? "Mythic" : "—";
              // Data age = newest report time across this char's in-week
              // Mythic parses.
              const newestReport = parses.reduce<number | null>((acc, p) => {
                const t = p.reportStartTime
                  ? new Date(p.reportStartTime).getTime()
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
                    {newestReport != null
                      ? relativeAge(newestReport, nowMs)
                      : "—"}
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
