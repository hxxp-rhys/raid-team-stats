"use client";

import { useId, useState } from "react";

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
type TimeWindow = "week" | "season";

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
 * Best Mythic DPS percentile per character. Toggle between:
 *   - Week (default): scoped to the current raid lockout via
 *     `weekPercentile` (per-kill ranks from WCL's `encounterRankings`).
 *   - Season: WCL's season/partition cumulative best via `percentile`.
 *
 * A character with no Mythic kill this lockout shows "—" in Week view;
 * a character with no Mythic ranking yet shows "—" in Season view too.
 */
export function WclParsesWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });
  // Capture "now" once at mount so render stays pure (Date.now() in render
  // trips react-hooks/purity in React 19).
  const [nowMs] = useState(() => Date.now());
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("week");
  // useId() — the page might host two of this widget; a hard-coded id would
  // collide and break label/select association on the second instance.
  const windowSelectId = useId();
  const isWeek = timeWindow === "week";

  return (
    <WidgetShell
      title="Warcraft Logs parses"
      description={
        isWeek
          ? "Best Mythic DPS percentile this raid lockout only (Tue reset → Tue reset)."
          : "Best Mythic DPS percentile across the full season."
      }
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        <>
          {/* Time-window toggle — local to this widget instance (not
              persisted yet). Defaults to Week, matching the prior
              hard-coded behaviour. */}
          <div className="mb-2 flex items-center justify-end gap-2 text-xs">
            <label
              htmlFor={windowSelectId}
              className="text-muted-foreground"
            >
              Window
            </label>
            <select
              id={windowSelectId}
              value={timeWindow}
              onChange={(e) => setTimeWindow(e.target.value as TimeWindow)}
              className="bg-background border-border h-7 rounded-md border px-1.5 text-xs"
            >
              <option value="week">This week</option>
              <option value="season">Season best</option>
            </select>
          </div>
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
              // Current RELEASE raids (server-resolved zone SET — patches add
              // raids to a release) + Mythic. The active field is
              // `weekPercentile` (this-lockout kills) for "This week" and
              // `percentile` (season best) otherwise — both from the same rows.
              const zoneIds = q.data.currentRaidZoneIds ?? [];
              const pickPct = (p: { weekPercentile: number | null; percentile: number | null }) =>
                isWeek ? p.weekPercentile : p.percentile;
              const parses = (m.latest.wclParses ?? []).filter(
                (p) =>
                  (zoneIds.length === 0 ||
                    (typeof p.zoneId === "number" && zoneIds.includes(p.zoneId))) &&
                  p.difficulty === MYTHIC &&
                  pickPct(p) != null,
              );
              const best = parses.reduce<
                { pct: number; name: string | null } | null
              >((acc, p) => {
                const pct = pickPct(p) ?? 0;
                return acc === null || pct > acc.pct
                  ? { pct, name: p.encounterName ?? null }
                  : acc;
              }, null);
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
        </>
      )}
    </WidgetShell>
  );
}
