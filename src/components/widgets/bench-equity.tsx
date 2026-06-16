"use client";

import { useMemo, useState } from "react";

import { api } from "@/lib/trpc-client";
import { wowClassColor } from "@/lib/wow";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Bench Equity — per-boss pull participation. Who's pulling vs who's sitting,
 * from the guild's public WCL logs (the same per-pull friendlyPlayers the
 * progression widgets use). A difficulty dropdown scopes the whole view to one
 * difficulty; each member's participation bar + a per-boss matrix (pulls
 * present of the boss's total, ✓ = in the kill pull). The most-benched
 * members surface at the bottom — who's owed a start.
 */

const diffName = (d: number): string =>
  ({ 5: "Mythic", 4: "Heroic", 3: "Normal", 1: "LFR" })[d] ?? `D${d}`;
const diffShort = (d: number): string =>
  ({ 5: "M", 4: "H", 3: "N", 1: "L" })[d] ?? `${d}`;

const shortLabel = (name: string, fallback: number): string =>
  name
    ? name
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .slice(0, 3)
        .toUpperCase()
    : `B${fallback}`;

const encKey = (e: { encounterId: number; difficulty: number }) =>
  `${e.encounterId}|${e.difficulty}`;

export function BenchEquityWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.benchEquity.useQuery({ raidTeamId });
  const [difficultySel, setDifficultySel] = useState<number | null>(null);

  const encounters = useMemo(() => q.data?.encounters ?? [], [q.data]);
  const difficulties = useMemo(
    () => [...new Set(encounters.map((e) => e.difficulty))].sort((a, b) => b - a),
    [encounters],
  );
  const difficulty = difficultySel ?? difficulties[0] ?? null;

  // Encounters at the selected difficulty (matrix columns capped to 8 widest).
  const diffEncounters = useMemo(
    () =>
      encounters
        .filter((e) => e.difficulty === difficulty)
        .sort((a, b) => b.totalPulls - a.totalPulls),
    [encounters, difficulty],
  );
  const cols = diffEncounters.slice(0, 8);
  const diffTotalPulls = diffEncounters.reduce((s, e) => s + e.totalPulls, 0);

  // Per-member participation FOR THIS DIFFICULTY (pulls present ÷ this
  // difficulty's total pulls). Only members who pulled it at all are shown.
  const rows = useMemo(() => {
    if (!q.data) return [];
    return q.data.members
      .map((m) => {
        let pullsIn = 0;
        for (const e of diffEncounters) pullsIn += m.byEnc[encKey(e)]?.pullsIn ?? 0;
        return {
          characterId: m.characterId,
          pullsIn,
          pullPct: diffTotalPulls > 0 ? (pullsIn / diffTotalPulls) * 100 : 0,
          byEnc: m.byEnc,
        };
      })
      .filter((m) => m.pullsIn > 0)
      .sort((a, b) => b.pullPct - a.pullPct);
  }, [q.data, diffEncounters, diffTotalPulls]);

  if (q.isPending) {
    return (
      <WidgetShell title="Bench equity" description={DESC}>
        <WidgetLoading />
      </WidgetShell>
    );
  }
  if (q.error) {
    return (
      <WidgetShell title="Bench equity" description={DESC}>
        <WidgetError message={q.error.message} />
      </WidgetShell>
    );
  }
  if (encounters.length === 0) {
    return (
      <WidgetShell title="Bench equity" description={DESC}>
        <WidgetEmpty>
          No logged pulls yet to measure participation. This fills in from the
          guild&apos;s public WCL logs as raids are logged.
        </WidgetEmpty>
      </WidgetShell>
    );
  }

  const { memberMeta, encounterNames, source } = q.data;

  const selector = (
    <select
      className="border-border bg-background rounded-md border px-1.5 py-1 text-xs"
      value={difficulty ?? ""}
      onChange={(e) => setDifficultySel(Number(e.target.value))}
      aria-label="Difficulty"
    >
      {difficulties.map((d) => (
        <option key={d} value={d}>
          {diffName(d)}
        </option>
      ))}
    </select>
  );

  return (
    <WidgetShell title="Bench equity" description={DESC} headerAction={selector}>
      <p className="text-muted-foreground mb-1 text-[10px]">
        {diffTotalPulls} {difficulty != null ? diffName(difficulty) : ""} pulls
        across {diffEncounters.length} boss{diffEncounters.length === 1 ? "" : "es"}{" "}
        — participation = pulls present ÷ all {difficulty != null ? diffName(difficulty) : ""} pulls
      </p>
      {rows.length === 0 || cols.length === 0 ? (
        <WidgetEmpty>No logged pulls at this difficulty yet.</WidgetEmpty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-border border-b text-left uppercase">
                <th className="py-1 pr-2 font-medium">Raider</th>
                <th className="py-1 pr-2 text-right font-medium">Part.</th>
                {cols.map((e) => (
                  <th
                    key={encKey(e)}
                    className="px-1 py-1 text-center font-medium"
                    title={`${encounterNames[e.encounterId] ?? `Encounter ${e.encounterId}`} (${diffShort(e.difficulty)}) — ${e.totalPulls} pulls, ${e.killPulls} kill${e.killPulls === 1 ? "" : "s"}`}
                  >
                    {shortLabel(encounterNames[e.encounterId] ?? "", e.encounterId)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {rows.map((m) => {
                const meta = memberMeta[m.characterId];
                return (
                  <tr key={m.characterId}>
                    <th
                      scope="row"
                      className="max-w-[8rem] truncate py-1 pr-2 text-left font-medium"
                      style={{ color: wowClassColor(meta?.classId) }}
                    >
                      {meta?.name ?? "Unknown"}
                    </th>
                    <td className="py-1 pr-2">
                      <span className="flex items-center justify-end gap-1">
                        <span className="bg-muted relative hidden h-2 w-12 overflow-hidden rounded-sm sm:block">
                          <span
                            className="absolute inset-y-0 left-0 rounded-sm bg-sky-500/80"
                            style={{ width: `${m.pullPct}%` }}
                          />
                        </span>
                        <span className="tabular-nums">
                          {Math.round(m.pullPct)}%
                        </span>
                      </span>
                    </td>
                    {cols.map((e) => {
                      const p = m.byEnc[encKey(e)];
                      const inPct = p ? (p.pullsIn / e.totalPulls) * 100 : 0;
                      return (
                        <td
                          key={encKey(e)}
                          className="px-1 py-1 text-center font-mono tabular-nums"
                          title={
                            p
                              ? `${p.pullsIn} of ${e.totalPulls} pulls${p.killPresent ? " · present for a kill" : ""}`
                              : `sat out all ${e.totalPulls} pulls`
                          }
                          style={{
                            backgroundColor: p
                              ? `rgba(56,189,248,${0.08 + (inPct / 100) * 0.32})`
                              : undefined,
                          }}
                        >
                          {p ? (
                            <>
                              {p.pullsIn}
                              {p.killPresent && (
                                <span className="text-emerald-500" title="in the kill">
                                  ✓
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-muted-foreground/50">·</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-muted-foreground mt-1.5 text-[10px]">
        ✓ = present for the kill · {source.name}
        {source.isOverride ? " (team source)" : ""}. Lower participation =
        sat/benched more (or joined recently).
      </p>
    </WidgetShell>
  );
}

const DESC =
  "Per-boss pull participation at one difficulty — who pulls vs who sits, with kill presence, from the guild's public WCL logs.";
