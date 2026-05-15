"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Per-character × per-encounter best-percentile heatmap. The single most
 * useful officer view: spot a character who parses fine on most fights but
 * dies on a specific boss. Each cell colour-codes by percentile.
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

  // Collect distinct encounter ids across all members so the column order is
  // stable. Use first-seen as the column order (rare cases of mis-numbered
  // encounters still render).
  const encounterOrder: number[] = [];
  const seenEncounters = new Set<number>();
  for (const m of q.data.members) {
    for (const p of m.latest.wclParses ?? []) {
      if (typeof p.encounterId !== "number") continue;
      if (!seenEncounters.has(p.encounterId)) {
        seenEncounters.add(p.encounterId);
        encounterOrder.push(p.encounterId);
      }
    }
  }

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
  const byChar = new Map<string, Map<number, number>>();
  for (const m of q.data.members) {
    const cellByEnc = new Map<number, number>();
    for (const p of m.latest.wclParses ?? []) {
      if (typeof p.encounterId !== "number") continue;
      if (typeof p.percentile !== "number") continue;
      const prior = cellByEnc.get(p.encounterId);
      if (prior === undefined || p.percentile > prior) {
        cellByEnc.set(p.encounterId, p.percentile);
      }
    }
    byChar.set(m.character.id, cellByEnc);
  }

  return (
    <WidgetShell
      title="Parses heatmap"
      description="Best percentile per character per encounter. Hover a cell for the value."
    >
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <caption className="sr-only">WCL parses by character and boss</caption>
          <thead>
            <tr className="text-muted-foreground text-left uppercase">
              <th scope="col" className="py-1 pr-2 font-medium">Character</th>
              {encounterOrder.map((eid) => (
                <th
                  key={eid}
                  scope="col"
                  className="py-1 pr-1 text-center font-medium"
                  title={`Encounter ${eid}`}
                >
                  {String(eid).slice(-3)}
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
                  {encounterOrder.map((eid) => {
                    const p = cells?.get(eid) ?? null;
                    return (
                      <td
                        key={eid}
                        className={`px-1 py-1 text-center font-mono ${colorFor(p)} ${textColorFor(p)}`}
                        title={p == null ? "no parse" : `${p}%`}
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
      </div>
    </WidgetShell>
  );
}
