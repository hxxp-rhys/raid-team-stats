"use client";

import { useId, useState } from "react";

import { api } from "@/lib/trpc-client";
import { Modal } from "@/components/ui/modal";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

type TimeWindow = "week" | "season";

const MYTHIC = 5;

type Drill = {
  characterId: string;
  characterName: string;
  encounterId: number;
  encounterName: string;
};

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
  const [drill, setDrill] = useState<Drill | null>(null);

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

  // Show the CURRENT RELEASE's raids — the WHOLE set the server tracks
  // together (e.g. Midnight 12.0.7 → zones 46 + 50), because patches ADD raids
  // to a release rather than replacing them. Filtering strictly to this set
  // keeps stale past-expansion parses (e.g. TWW's zone 44) out. If the server
  // couldn't resolve it, fall back to every zone present in the data.
  const serverZoneIds = q.data.currentRaidZoneIds ?? [];
  const currentZoneIds = new Set<number>(serverZoneIds);
  if (currentZoneIds.size === 0) {
    for (const m of q.data.members) {
      for (const p of m.latest.wclParses ?? []) {
        if (typeof p.zoneId === "number") currentZoneIds.add(p.zoneId);
      }
    }
  }
  const inCurrent = (zoneId: number | null | undefined) =>
    typeof zoneId === "number" && currentZoneIds.has(zoneId);

  // Collect distinct encounters (id + name) for the current zone only.
  // SEED first with the live zone's FULL boss list from the server, so EVERY
  // boss gets a column — including a brand-new encounter (e.g. Rotmire on a
  // freshly-released raid) that nobody has parsed yet. Without this seed the
  // legend was built purely from stored parses, so a boss with zero kills
  // never appeared. Parse rows below only refine names / fill cells; they
  // never gate which encounters show. Sorted by encounter id so the column
  // order is stable (== pull/boss order within the raid).
  const encMap = new Map<number, { name: string; zoneId: number }>();
  // Seed with the live release's FULL boss list (every release zone), so EVERY
  // boss gets a column — including brand-new ones nobody has parsed yet.
  if (serverZoneIds.length > 0) {
    for (const enc of q.data.currentZoneEncounters ?? []) {
      encMap.set(enc.id, { name: enc.name ?? "", zoneId: enc.zoneId });
    }
  }
  for (const m of q.data.members) {
    for (const p of m.latest.wclParses ?? []) {
      if (typeof p.encounterId !== "number") continue;
      if (!inCurrent(p.zoneId)) continue;
      if (typeof p.difficulty === "number" && p.difficulty !== MYTHIC) continue;
      const cur = encMap.get(p.encounterId);
      if (!cur) {
        encMap.set(p.encounterId, {
          name: p.encounterName ?? "",
          zoneId: p.zoneId ?? 0,
        });
      } else if (p.encounterName && !cur.name) {
        cur.name = p.encounterName;
      }
    }
  }
  // Group by zone (release order — launch raids first), then by encounter id
  // within each raid, so the columns read as full raids left-to-right.
  const encounterOrder = [...encMap.entries()]
    .map(([id, v]) => ({ id, name: v.name, zoneId: v.zoneId }))
    .sort((a, b) => a.zoneId - b.zoneId || a.id - b.id);

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
      if (!inCurrent(p.zoneId)) continue; // current release only
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
                    if (p == null) {
                      return (
                        <td
                          key={enc.id}
                          className={`px-1 py-1 text-center font-mono ${colorFor(p)} ${textColorFor(p)}`}
                          title={`${enc.name || `Encounter ${enc.id}`}: no parse`}
                        >
                          —
                        </td>
                      );
                    }
                    return (
                      <td key={enc.id} className="p-0 text-center">
                        <button
                          type="button"
                          onClick={() =>
                            setDrill({
                              characterId: m.character.id,
                              characterName: m.character.name,
                              encounterId: enc.id,
                              encounterName: enc.name,
                            })
                          }
                          className={`hover:ring-primary w-full px-1 py-1 text-center font-mono hover:ring-1 hover:ring-inset ${colorFor(p)} ${textColorFor(p)}`}
                          title={`${enc.name || `Encounter ${enc.id}`}: ${p}% — click for per-kill history`}
                        >
                          {Math.round(p)}
                        </button>
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
      {drill && (
        <KillDetailModal
          raidTeamId={raidTeamId}
          difficulty={MYTHIC}
          drill={drill}
          onClose={() => setDrill(null)}
        />
      )}
    </WidgetShell>
  );
}

/** Per-kill history for one (character, boss) — lazily fetched on cell click. */
function KillDetailModal({
  raidTeamId,
  difficulty,
  drill,
  onClose,
}: {
  raidTeamId: string;
  difficulty: number;
  drill: Drill;
  onClose: () => void;
}) {
  const q = api.snapshot.encounterKills.useQuery({
    raidTeamId,
    characterId: drill.characterId,
    encounterId: drill.encounterId,
    difficulty,
  });
  const boss = drill.encounterName || `Encounter ${drill.encounterId}`;
  return (
    <Modal
      open
      onClose={onClose}
      title={`${drill.characterName} — ${boss}`}
      description="Per-kill Mythic percentile history (newest first)"
      hideDefaultFooter
    >
      {q.isPending ? (
        <p className="text-muted-foreground text-xs">Loading kills…</p>
      ) : q.error ? (
        <p className="text-xs text-rose-400">{q.error.message}</p>
      ) : q.data.kills.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No logged Mythic kills on this boss yet.
        </p>
      ) : (
        <ul className="divide-border max-h-80 divide-y overflow-y-auto text-xs">
          {q.data.kills.map((k, i) => (
            <li
              key={`${k.reportCode}-${k.t}-${i}`}
              className="flex items-center justify-between gap-3 py-1.5"
            >
              <span className="text-muted-foreground tabular-nums">
                {new Date(k.t).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </span>
              <span className={`font-mono font-semibold ${textColorFor(k.pct)}`}>
                {Math.round(k.pct)}%
              </span>
              {k.reportCode ? (
                <a
                  href={`https://www.warcraftlogs.com/reports/${k.reportCode}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary shrink-0 underline decoration-dotted hover:no-underline"
                >
                  view log ↗
                </a>
              ) : (
                <span className="text-muted-foreground shrink-0">—</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

