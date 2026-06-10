"use client";

import { useId, useState } from "react";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

type TimeWindow = "week" | "season";

/**
 * Per-character × per-encounter best-percentile heatmap. The single most
 * useful officer view: spot a character who parses fine on most fights but
 * dies on a specific boss. Each cell colour-codes by percentile. A "Window"
 * dropdown switches between this-lockout best (`weekPercentile`) and
 * season-cumulative best (`percentile`).
 */

function colorFor(p: number | null): string {
  if (p == null) return "bg-muted";
  if (p >= 99) return "bg-orange-400/40";
  if (p >= 95) return "bg-purple-400/40";
  if (p >= 75) return "bg-blue-400/40";
  if (p >= 50) return "bg-green-400/30";
  if (p >= 25) return "bg-emerald-400/20";
  return "bg-rose-400/20";
}

function textColorFor(p: number | null): string {
  if (p == null) return "text-muted-foreground";
  if (p >= 99) return "text-orange-300";
  if (p >= 95) return "text-purple-300";
  if (p >= 75) return "text-blue-300";
  if (p >= 50) return "text-green-300";
  if (p >= 25) return "text-emerald-300";
  return "text-rose-300";
}

export function ParsesHeatmapWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });
  // Default to "season" — matches the prior hard-coded behaviour. A user
  // who wants the lockout-only view can flip to "week".
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("season");
  // useId() — a dashboard may host two heatmap widgets; a hard-coded id
  // would collide and break the label/select association on the second.
  const windowSelectId = useId();
  const isWeek = timeWindow === "week";

  if (q.isPending) {
    return (
      <WidgetShell title="Parses heatmap">
        <WidgetLoading />
      </WidgetShell>
    );
  }
  if (q.error) {
    return (
      <WidgetShell title="Parses heatmap">
        <WidgetError message={q.error.message} />
      </WidgetShell>
    );
  }

  // Only show the CURRENT raid tier (WoW Midnight). The zone id is resolved
  // server-side (env-pinned to the live raid) and returned with the query —
  // we filter strictly to it so a stale past-expansion parse (e.g. The War
  // Within's Manaforge Omega = zone 44) can never appear, even if such rows
  // still exist in the DB. If the server couldn't resolve it, fall back to
  // the highest zone id present in the data.
  const MYTHIC = 5;
  const serverZone = q.data.currentRaidZoneId;
  let currentZone = serverZone ?? -1;
  if (serverZone == null) {
    for (const m of q.data.members) {
      for (const p of m.latest.wclParses ?? []) {
        if (typeof p.zoneId === "number" && p.zoneId > currentZone)
          currentZone = p.zoneId;
      }
    }
  }

  // Collect distinct encounters (id + name) for the current zone only.
  // Pull the name from whichever parse row carries it. Sorted by encounter
  // id so the column order is stable (== pull/boss order within the raid).
  const encMap = new Map<number, string>();
  for (const m of q.data.members) {
    for (const p of m.latest.wclParses ?? []) {
      if (typeof p.encounterId !== "number") continue;
      if (p.zoneId !== currentZone) continue;
      if (typeof p.difficulty === "number" && p.difficulty !== MYTHIC) continue;
      if (!encMap.has(p.encounterId) || (p.encounterName && !encMap.get(p.encounterId))) {
        encMap.set(p.encounterId, p.encounterName ?? "");
      }
    }
  }
  const encounterOrder = [...encMap.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.id - b.id);

  if (encounterOrder.length === 0) {
    return (
      <WidgetShell title="Parses heatmap">
        <WidgetEmpty>
          No WCL parses yet for any member. Trigger a Tier A sync.
        </WidgetEmpty>
      </WidgetShell>
    );
  }

  // Build a Map<characterId, Map<encounterId, bestPercentile>> for O(1) lookup.
  // The "active" percentile field swaps with the dropdown — both come from
  // the same wclParse rows so this is purely a render-time projection.
  const byChar = new Map<string, Map<number, number>>();
  for (const m of q.data.members) {
    const cellByEnc = new Map<number, number>();
    for (const p of m.latest.wclParses ?? []) {
      if (typeof p.encounterId !== "number") continue;
      const pct = isWeek ? p.weekPercentile : p.percentile;
      if (typeof pct !== "number") continue;
      if (p.zoneId !== currentZone) continue; // current raid only
      if (typeof p.difficulty === "number" && p.difficulty !== MYTHIC) continue;
      const prior = cellByEnc.get(p.encounterId);
      if (prior === undefined || pct > prior) {
        cellByEnc.set(p.encounterId, pct);
      }
    }
    byChar.set(m.character.id, cellByEnc);
  }

  // Short column label: boss initials (e.g. "Soulbinder Naazindhri" → "SN").
  // Full name is in the header title + a name row above the grid.
  const shortLabel = (name: string, idx: number) =>
    name
      ? name
          .split(/\s+/)
          .map((w) => w[0])
          .join("")
          .slice(0, 3)
          .toUpperCase()
      : `B${idx + 1}`;

  return (
    <WidgetShell
      title="Parses heatmap"
      description={
        isWeek
          ? "Best Mythic percentile per character per boss, this lockout only. Hover a cell or header for detail."
          : "Best Mythic percentile per character per boss, season cumulative. Hover a cell or header for detail."
      }
    >
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
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <caption className="sr-only">WCL parses by character and boss</caption>
          <thead>
            <tr className="text-muted-foreground text-left uppercase">
              <th scope="col" className="py-1 pr-2 font-medium">Character</th>
              {encounterOrder.map((enc, idx) => (
                <th
                  key={enc.id}
                  scope="col"
                  className="py-1 pr-1 text-center font-medium"
                  title={enc.name || `Encounter ${enc.id}`}
                >
                  {shortLabel(enc.name, idx)}
                </th>
              ))}
              <th scope="col" className="py-1 pr-1 text-right font-medium">
                Best
              </th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {q.data.members.map((m) => {
              const cells = byChar.get(m.character.id);
              const best = cells
                ? Math.max(...Array.from(cells.values()), 0)
                : 0;
              return (
                <tr key={m.character.id}>
                  <td className="py-1.5 pr-2 font-medium">{m.character.name}</td>
                  {encounterOrder.map((enc) => {
                    const p = cells?.get(enc.id) ?? null;
                    return (
                      <td
                        key={enc.id}
                        className={`px-1 py-1 text-center font-mono ${colorFor(p)} ${textColorFor(p)}`}
                        title={
                          p == null
                            ? `${enc.name || `Encounter ${enc.id}`}: no parse`
                            : `${enc.name || `Encounter ${enc.id}`}: ${p}%`
                        }
                      >
                        {p == null ? "—" : Math.round(p)}
                      </td>
                    );
                  })}
                  <td
                    className={`py-1.5 pr-1 text-right font-mono ${textColorFor(best || null)}`}
                  >
                    {best > 0 ? Math.round(best) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <ol className="text-muted-foreground mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] sm:grid-cols-3">
          {encounterOrder.map((enc, idx) => (
            <li key={enc.id}>
              <span className="font-mono">{shortLabel(enc.name, idx)}</span>
              {" — "}
              {enc.name || `Encounter ${enc.id}`}
            </li>
          ))}
        </ol>
      </div>
    </WidgetShell>
  );
}

