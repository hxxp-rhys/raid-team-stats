"use client";

import { useMemo, useState } from "react";

import { api } from "@/lib/trpc-client";
import { wowClassColor } from "@/lib/wow";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Learning Curve — per-player mechanic learning rate on a boss. Across a
 * boss's chronological wipe pulls, are they STILL among the first to die
 * (the deaths that cause wipes), or have they stopped? Raw death rate is
 * saturated on wipes, so the signal is EARLY-death rate (death order ≤ 2) +
 * survival depth, measured early-half vs late-half and normalised against the
 * TEAM's improvement so "the boss got harder" doesn't read as one player
 * stalling. A ⚑ flag marks a coaching candidate: improved meaningfully less
 * than the team AND still at/above the team's current rate — shown only
 * alongside its early→late evidence. From the guild's public WCL logs; the
 * widget never spends WCL points.
 */

const diffName = (d: number): string =>
  ({ 5: "Mythic", 4: "Heroic", 3: "Normal", 1: "LFR" })[d] ?? `D${d}`;

const TREND_META: Record<
  string,
  { label: string; glyph: string; cls: string }
> = {
  improving: { label: "Improving", glyph: "▲", cls: "text-emerald-500" },
  flat: { label: "Flat", glyph: "▬", cls: "text-muted-foreground" },
  regressing: { label: "Regressing", glyph: "▼", cls: "text-rose-500" },
};

const DESC =
  "Per-player mechanic learning rate on a boss — who stops dying early as the team progresses, team-relative, from the guild's public WCL logs.";

const secs = (ms: number | null) => (ms == null ? "—" : `${Math.round(ms / 1000)}s`);

export function LearningCurveWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.learningCurve.useQuery({ raidTeamId });
  const [difficultySel, setDifficultySel] = useState<number | null>(null);
  const [encounterSel, setEncounterSel] = useState<number | null>(null);

  const encounters = useMemo(() => q.data?.encounters ?? [], [q.data]);
  const difficulties = useMemo(
    () => [...new Set(encounters.map((e) => e.difficulty))].sort((a, b) => b - a),
    [encounters],
  );
  const difficulty = difficultySel ?? difficulties[0] ?? null;
  const atDifficulty = useMemo(
    () => encounters.filter((e) => e.difficulty === difficulty),
    [encounters, difficulty],
  );
  const encounterId = encounterSel ?? atDifficulty[0]?.encounterId ?? null;
  const encounter = atDifficulty.find((e) => e.encounterId === encounterId) ?? null;

  if (q.isPending) {
    return (
      <WidgetShell title="Learning curve" description={DESC}>
        <WidgetLoading />
      </WidgetShell>
    );
  }
  if (q.error) {
    return (
      <WidgetShell title="Learning curve" description={DESC}>
        <WidgetError message={q.error.message} />
      </WidgetShell>
    );
  }
  if (encounters.length === 0) {
    return (
      <WidgetShell title="Learning curve" description={DESC}>
        <WidgetEmpty>
          Not enough logged progression yet. A learning trend needs a player to
          have attended at least a dozen of a boss&apos;s wipe pulls (enough to
          split into an early and a late half) — trends appear once a real prog
          week is logged.
        </WidgetEmpty>
      </WidgetShell>
    );
  }

  const names = q.data.encounterNames;
  const members = q.data.members;
  // Ready slot: the avoidable-damage column only renders once the enrichment
  // (verified WCL `table(DamageTaken, abilityID)` or the addon's C_DamageMeter)
  // populates `*Avoidable`. Until that ingest lands it's always false → hidden,
  // so the widget never shows an empty/promised column.
  const anyAvoidable = encounter?.members.some((m) => m.lateAvoidable != null) ?? false;

  const selector = (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <select
        className="border-border bg-background rounded-md border px-1.5 py-1"
        value={encounterId ?? ""}
        onChange={(e) => setEncounterSel(Number(e.target.value))}
        aria-label="Boss"
      >
        {atDifficulty.map((e) => (
          <option key={e.encounterId} value={e.encounterId}>
            {names[e.encounterId] ?? `Encounter ${e.encounterId}`} ({e.wipePulls})
          </option>
        ))}
      </select>
      <select
        className="border-border bg-background rounded-md border px-1.5 py-1"
        value={difficulty ?? ""}
        onChange={(e) => {
          setDifficultySel(Number(e.target.value));
          setEncounterSel(null);
        }}
        aria-label="Difficulty"
      >
        {difficulties.map((d) => (
          <option key={d} value={d}>
            {diffName(d)}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <WidgetShell title="Learning curve" description={DESC} headerAction={selector}>
      {encounter && encounter.members.length > 0 ? (
        <div className="min-w-0 overflow-x-auto">
          <p className="text-muted-foreground mb-1 text-[10px]">
            {encounter.wipePulls} wipes · early-death rate (first to fall) early
            half → late half, vs the team&apos;s own improvement
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-border border-b text-left">
                <th className="py-1 pr-2 font-medium">Raider</th>
                <th className="py-1 pr-2 font-medium">Trend</th>
                <th className="py-1 pr-2 text-right font-medium">Early-death</th>
                <th className="hidden py-1 pr-2 text-right font-medium sm:table-cell">
                  Survival
                </th>
                {anyAvoidable && (
                  <th className="hidden py-1 pr-2 text-right font-medium md:table-cell">
                    Avoid. dmg
                  </th>
                )}
                <th className="py-1 pl-2 text-right font-medium">vs team</th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {encounter.members.map((m) => {
                const meta = members[m.characterId];
                const t = TREND_META[m.trend] ?? TREND_META.flat!;
                return (
                  <tr key={m.characterId} className={m.flagged ? "bg-rose-500/5" : ""}>
                    <th
                      scope="row"
                      className="max-w-[8rem] truncate py-1 pr-2 text-left font-medium"
                      style={{ color: wowClassColor(meta?.classId) }}
                    >
                      {m.flagged && (
                        <span title="Coaching candidate — improved less than the team and still at/above its early-death rate">
                          ⚑{" "}
                        </span>
                      )}
                      {meta?.name ?? "Unknown"}
                    </th>
                    <td className={`py-1 pr-2 ${t.cls}`} title={t.label}>
                      {t.glyph} {t.label}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      <span className="text-muted-foreground">
                        {(m.earlyDeathRate * 100).toFixed(0)}%
                      </span>{" "}
                      →{" "}
                      <span
                        className={
                          m.lateDeathRate < m.earlyDeathRate
                            ? "text-emerald-500"
                            : m.lateDeathRate > m.earlyDeathRate
                              ? "text-rose-500"
                              : ""
                        }
                      >
                        {(m.lateDeathRate * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td className="text-muted-foreground hidden py-1 pr-2 text-right tabular-nums sm:table-cell">
                      {secs(m.earlySurvivalMs)}→{secs(m.lateSurvivalMs)}
                    </td>
                    {anyAvoidable && (
                      <td className="text-muted-foreground hidden py-1 pr-2 text-right tabular-nums md:table-cell">
                        {m.earlyAvoidable != null && m.lateAvoidable != null
                          ? `${Math.round(m.earlyAvoidable / 1000)}k→${Math.round(m.lateAvoidable / 1000)}k`
                          : "—"}
                      </td>
                    )}
                    <td className="py-1 pl-2 text-right tabular-nums">
                      {m.relativeRatio == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={
                            m.flagged
                              ? "text-rose-500"
                              : m.relativeRatio < 0.85
                                ? "text-emerald-500"
                                : "text-muted-foreground"
                          }
                          title="Their late÷early rate ÷ the team's — above 1 = improved less than the team"
                        >
                          {m.relativeRatio.toFixed(2)}×
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <WidgetEmpty>
          Not enough pulls per player on this boss yet to split early vs late.
        </WidgetEmpty>
      )}
      <p className="text-muted-foreground mt-1.5 text-[10px]">
        ⚑ coaching candidate · {q.data.source.name}
        {q.data.source.isOverride ? " (team source)" : ""}.{" "}
        <span className="text-amber-600/90 dark:text-amber-500/90">
          Deaths-based, with no role/duty context — sanity-check an assigned
          soak, kite, or tank death before coaching.
        </span>
      </p>
    </WidgetShell>
  );
}
