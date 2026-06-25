"use client";

import { useMemo, useState } from "react";

import { api, type RouterOutputs } from "@/lib/trpc-client";
import { bandOf, slopeBadge } from "@/lib/parse-consistency";
import { wowClassColor } from "@/lib/wow";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";
import {
  SortableHeader,
  useSortableColumns,
  type ColumnMap,
} from "./sortable-table";

/**
 * Parse Consistency — median/best/variance (tab 1) and week-over-week
 * relative improvement (tab 2). The framing the research mandates: a high
 * best with a low median is inconsistency, not skill shortage; medians and
 * slopes are what roster decisions should read, never best-ever parses.
 */
export function ParseConsistencyWidget({ raidTeamId }: { raidTeamId: string }) {
  // null = let the server pick the highest difficulty with data; an explicit
  // pick refetches that tier only. N/H/M parse populations are not
  // equivalent, so tiers are never mixed in one view.
  const [difficultySel, setDifficultySel] = useState<3 | 4 | 5 | null>(null);
  const q = api.snapshot.parseConsistency.useQuery({
    raidTeamId,
    difficulty: difficultySel ?? undefined,
  });

  const [tab, setTab] = useState<"snapshot" | "trend">("snapshot");
  const [encounterSel, setEncounterSel] = useState<number | "all">("all");

  const encounters = useMemo(() => {
    const seen = new Map<number, string | null>();
    for (const m of q.data?.members ?? []) {
      for (const e of m.encounters) {
        if (!seen.has(e.encounterId)) seen.set(e.encounterId, e.encounterName);
      }
    }
    return [...seen.entries()];
  }, [q.data]);

  if (q.isPending) {
    return (
      <Shell tab={tab} setTab={setTab}>
        <WidgetLoading />
      </Shell>
    );
  }
  if (q.error) {
    return (
      <Shell tab={tab} setTab={setTab}>
        <WidgetError message={q.error.message} />
      </Shell>
    );
  }

  const { members, partition, difficulty, availableDifficulties } = q.data;
  const diffName = (d: number) =>
    ({ 5: "Mythic", 4: "Heroic", 3: "Normal" })[d] ?? `D${d}`;

  // Difficulty picker is always offered when ANY tier has data — switching
  // tiers refetches. Options = tiers with data, plus the current selection.
  const diffOptions = [
    ...new Set([...availableDifficulties, difficulty]),
  ].sort((a, b) => b - a);
  const difficultyPicker = diffOptions.length > 0 && (
    <select
      className="border-border bg-background rounded-md border px-1.5 py-1"
      value={difficulty}
      onChange={(e) => setDifficultySel(Number(e.target.value) as 3 | 4 | 5)}
      aria-label="Raid difficulty"
      title="Normal / Heroic / Mythic parse populations are separate — tiers are never mixed."
    >
      {diffOptions.map((d) => (
        <option key={d} value={d}>
          {diffName(d)}
        </option>
      ))}
    </select>
  );

  const hasAnyParses = members.some((m) => m.encounters.length > 0);
  if (!hasAnyParses) {
    return (
      <Shell tab={tab} setTab={setTab}>
        <div className="mb-2 flex items-center gap-2 text-xs">
          {difficultyPicker}
        </div>
        <WidgetEmpty>
          {availableDifficulties.length > 0
            ? `No ${diffName(difficulty)} parses for the current tier — try another difficulty above.`
            : "No parses for the current tier yet. Parses appear once members' boss kills are publicly logged and the hourly sync has run (each raid tier is ingested separately once the team has kills there)."}
        </WidgetEmpty>
      </Shell>
    );
  }

  return (
    <Shell tab={tab} setTab={setTab} partition={partition}>
      {tab === "snapshot" ? (
        <>
          <div className="mb-2 flex items-center gap-2 text-xs">
            {difficultyPicker}
            <select
              className="border-border bg-background rounded-md border px-1.5 py-1"
              value={encounterSel}
              onChange={(e) =>
                setEncounterSel(
                  e.target.value === "all" ? "all" : Number(e.target.value),
                )
              }
              aria-label="Boss"
            >
              <option value="all">All bosses (zone average)</option>
              {encounters.map(([id, name]) => (
                <option key={id} value={id}>
                  {name ?? `Encounter ${id}`}
                </option>
              ))}
            </select>
          </div>
          <SnapshotTab members={members} encounterSel={encounterSel} />
        </>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2 text-xs">
            {difficultyPicker}
          </div>
          <TrendTab members={members} />
        </>
      )}
    </Shell>
  );
}

type Members = RouterOutputs["snapshot"]["parseConsistency"]["members"];

function Shell({
  tab,
  setTab,
  partition,
  children,
}: {
  tab: "snapshot" | "trend";
  setTab: (t: "snapshot" | "trend") => void;
  partition?: number | null;
  children: React.ReactNode;
}) {
  return (
    <WidgetShell
      title="Parse consistency"
      description="Median, gap and variance — the numbers rosters actually run on."
    >
      <div
        role="tablist"
        className="border-border mb-2 flex items-center gap-1 border-b text-xs"
      >
        {(
          [
            ["snapshot", "Snapshot"],
            ["trend", "Trend"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-2 py-1 font-medium transition-colors ${
              tab === id
                ? "border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground border-transparent"
            }`}
          >
            {label}
          </button>
        ))}
        {partition != null && (
          <span
            className="text-muted-foreground ml-auto text-[10px]"
            title="WCL ranking partition — percentiles reset when a new partition opens (e.g. mid-season raid additions)."
          >
            partition {partition}
          </span>
        )}
      </div>
      {children}
    </WidgetShell>
  );
}

const BAND_COLORS: Record<ReturnType<typeof bandOf>, string> = {
  gold: "#e5cc80",
  pink: "#e268a8",
  orange: "#ff8000",
  purple: "#a335ee",
  blue: "#0070ff",
  green: "#1eff00",
  grey: "#9d9d9d",
};

function RoleChip({ role }: { role: "tank" | "healer" | "dps" }) {
  if (role === "dps") return null;
  return (
    <span
      className="border-border text-muted-foreground ml-1 rounded-full border px-1 py-px text-[9px] leading-none"
      title={`${role === "healer" ? "Healer" : "Tank"} measured on the dps metric — their job isn't damage, so read this row as context, not ranking (role-true hps/tankhps ingestion is a planned follow-up).`}
    >
      dps metric
    </span>
  );
}

type SnapshotRow = {
  member: Members[number];
  median: number | null;
  best: number | null;
  volatility: number | null;
  kills: number | null;
  lowSample: boolean;
};

type SnapshotSortKey = "member" | "med" | "best" | "sigma" | "n";

// The median●——○best bar column is purely visual and stays a plain header.
const SNAPSHOT_COLUMNS: ColumnMap<SnapshotRow, SnapshotSortKey> = {
  member: { key: "member", accessor: (r) => r.member.character.name, kind: "text" },
  med: { key: "med", accessor: (r) => r.median, kind: "number" },
  best: { key: "best", accessor: (r) => r.best, kind: "number" },
  sigma: { key: "sigma", accessor: (r) => r.volatility, kind: "number" },
  n: { key: "n", accessor: (r) => r.kills, kind: "number" },
};

function SnapshotTab({
  members,
  encounterSel,
}: {
  members: Members;
  encounterSel: number | "all";
}) {
  type Row = SnapshotRow;
  // WCL returns 0 (not null) for a logged-but-unrated boss, so treat 0 as "no
  // score" — otherwise an unrated boss (e.g. a brand-new raid boss) shows a
  // misleading "0" and drags the All-bosses average down.
  const hasScore = (v: number | null | undefined): v is number =>
    v != null && v > 0;
  const baseRows: Row[] = members
    .map((m) => {
      if (encounterSel === "all") {
        // WCL's whole-zone aggregates (already 0-filtered server-side); hasScore
        // guards a stray 0 from rendering as a real score.
        return {
          member: m,
          median: hasScore(m.medianAvg) ? m.medianAvg : null,
          best: hasScore(m.bestAvg) ? m.bestAvg : null,
          volatility: null,
          kills: m.encounters.reduce<number | null>(
            (s, e) => (e.kills == null ? s : (s ?? 0) + e.kills),
            null,
          ),
          lowSample: false,
        };
      }
      const e = m.encounters.find((x) => x.encounterId === encounterSel);
      return {
        member: m,
        median: hasScore(e?.median) ? e!.median : null,
        best: hasScore(e?.best) ? e!.best : null,
        volatility: e?.volatility ?? null,
        kills: e?.kills ?? null,
        lowSample: e != null && (e.kills ?? 0) < 4,
      };
    })
    // Keep a member if they have a real score OR a logged kill — so a boss with
    // kills-but-no-score still lists who killed it (with "—").
    .filter((r) => r.median != null || r.best != null || (r.kills ?? 0) > 0);

  // Default: median percentile, high-first (the historical order).
  const {
    sorted: rows,
    sortKey,
    asc,
    toggle,
  } = useSortableColumns(baseRows, {
    columns: SNAPSHOT_COLUMNS,
    initial: { key: "med", asc: false },
    tieBreaker: (r) => r.member.character.name,
  });

  // Specific boss selected, members have logged kills on it, but nobody has a
  // real WCL score yet → notice under the dropdowns.
  const selectedNoScore =
    encounterSel !== "all" &&
    (() => {
      const sel = members
        .map((m) => m.encounters.find((e) => e.encounterId === encounterSel))
        .filter((e): e is NonNullable<typeof e> => e != null);
      return (
        sel.some((e) => (e.kills ?? 0) > 0) &&
        !sel.some((e) => hasScore(e.best) || hasScore(e.median))
      );
    })();
  const notice = selectedNoScore ? (
    <p className="border-amber-500/30 bg-amber-500/10 mb-2 rounded border px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
      This boss has logged kills but Warcraft Logs hasn&rsquo;t published parse
      scores for it yet — percentiles will appear once WCL rates it.
    </p>
  ) : null;

  if (rows.length === 0) {
    return (
      <div>
        {notice}
        <WidgetEmpty>No parses for this boss yet.</WidgetEmpty>
      </div>
    );
  }

  return (
    <div>
      {notice}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground text-left">
            <SortableHeader label="Member" col="member" active={sortKey === "member"} asc={asc} onSort={toggle} weight="normal" uppercase={false} className="pr-2" />
            <th className="w-1/2 py-1 pr-2 font-normal">
              median ●——○ best
            </th>
            <SortableHeader label="med" col="med" active={sortKey === "med"} asc={asc} onSort={toggle} align="right" weight="normal" uppercase={false} className="pr-2" title="Season median percentile" />
            <SortableHeader label="best" col="best" active={sortKey === "best"} asc={asc} onSort={toggle} align="right" weight="normal" uppercase={false} className="pr-2" title="Season best percentile" />
            <SortableHeader label="σ" col="sigma" active={sortKey === "sigma"} asc={asc} onSort={toggle} align="right" weight="normal" uppercase={false} className="pr-2" title="Std-dev of per-kill percentiles (≥4 kills) — lower = steadier" />
            <SortableHeader label="n" col="n" active={sortKey === "n"} asc={asc} onSort={toggle} align="right" weight="normal" uppercase={false} className="pr-0" title="Logged kills" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const median = r.median;
            const best = r.best;
            const color =
              median != null ? BAND_COLORS[bandOf(median)] : "var(--border)";
            return (
              <tr
                key={r.member.character.id}
                className={r.lowSample ? "opacity-50" : undefined}
                title={
                  r.lowSample
                    ? "Fewer than 4 logged kills — too small a sample to judge."
                    : undefined
                }
              >
                <td
                  className="max-w-28 truncate py-1 pr-2 font-medium"
                  style={{ color: wowClassColor(r.member.character.classId) }}
                >
                  {r.member.character.name}
                  <RoleChip role={r.member.role} />
                </td>
                <td className="py-1 pr-2">
                  <div className="bg-muted/40 relative h-2 w-full rounded-full">
                    {median != null && best != null && best > median && (
                      <div
                        className="absolute inset-y-0 rounded-full opacity-40"
                        style={{
                          left: `${median}%`,
                          width: `${best - median}%`,
                          backgroundColor: color,
                        }}
                      />
                    )}
                    {median != null && (
                      <div
                        className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                        style={{ left: `${median}%`, backgroundColor: color }}
                        title={`median ${median.toFixed(1)}`}
                      />
                    )}
                    {best != null && (
                      <div
                        className="bg-background absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                        style={{ left: `${best}%`, borderColor: color }}
                        title={`best ${best.toFixed(1)}`}
                      />
                    )}
                  </div>
                </td>
                <td className="py-1 pr-2 text-right font-mono" style={{ color }}>
                  {median != null ? median.toFixed(0) : "—"}
                </td>
                <td className="text-muted-foreground py-1 pr-2 text-right font-mono">
                  {best != null ? best.toFixed(0) : "—"}
                </td>
                <td className="text-muted-foreground py-1 pr-2 text-right font-mono">
                  {r.volatility != null ? r.volatility.toFixed(1) : "—"}
                </td>
                <td className="text-muted-foreground py-1 text-right font-mono">
                  {r.kills ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-muted-foreground mt-1.5 text-[10px]">
        A wide ●——○ gap is inconsistency, not a skill ceiling — coach the
        median, don’t chase the best. σ needs ≥4 logged kills. Rows with
        &lt;4 kills are greyed. Healers/tanks carry a “dps metric” chip —
        context, not ranking.
      </p>
    </div>
  );
}

function TrendTab({ members }: { members: Members }) {
  const ranked = [...members].sort((a, b) => {
    // dps with data first, then healers/tanks (dps-metric caveat), then no-data.
    const aKey = (a.qualifyingWeeks >= 3 ? 0 : 2) + (a.role === "dps" ? 0 : 1);
    const bKey = (b.qualifyingWeeks >= 3 ? 0 : 2) + (b.role === "dps" ? 0 : 1);
    if (aKey !== bKey) return aKey - bKey;
    return (b.slope ?? -99) - (a.slope ?? -99);
  });

  const anyTrend = members.some((m) => m.qualifyingWeeks >= 3);
  if (!anyTrend) {
    return (
      <WidgetEmpty>
        Needs at least 3 qualifying lockouts (≥2 bosses killed-and-logged per
        week) for anyone before trends mean anything.
      </WidgetEmpty>
    );
  }

  return (
    <div>
      <ul className="space-y-1">
        {ranked.map((m) => {
          const badge = m.qualifyingWeeks >= 3 ? slopeBadge(m.slope) : null;
          return (
            <li key={m.character.id} className="flex items-center gap-2 text-xs">
              <span
                className="w-28 shrink-0 truncate font-medium"
                style={{ color: wowClassColor(m.character.classId) }}
              >
                {m.character.name}
                <RoleChip role={m.role} />
              </span>
              <RelSparkline trend={m.trend} />
              <span
                className={`w-8 shrink-0 text-center font-mono ${
                  badge === "up"
                    ? "text-green-500"
                    : badge === "down"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }`}
                title={
                  m.slope != null
                    ? `${m.slope >= 0 ? "+" : ""}${m.slope.toFixed(1)} percentile-points per QUALIFYING lockout vs roster (gaps are compressed out of the axis), Theil–Sen over the last ${m.qualifyingWeeks} qualifying lockouts`
                    : "Fewer than 3 qualifying lockouts"
                }
              >
                {badge === "up" ? "▲" : badge === "down" ? "▼" : badge === "flat" ? "▬" : "—"}
              </span>
              <span className="text-muted-foreground w-10 shrink-0 text-right text-[10px]">
                {m.qualifyingWeeks} wk{m.qualifyingWeeks === 1 ? "" : "s"}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-muted-foreground mt-1.5 text-[10px]">
        Line = weekly median of week-best kills relative to the roster median
        (0 = roster-typical). Kill-execution trend, not prog effort — wipes
        don’t rank, and benched weeks are gaps, never declines.
      </p>
    </div>
  );
}

function RelSparkline({
  trend,
}: {
  trend: Array<{ weekStart: string; rel: number }>;
}) {
  const W = 160;
  const H = 18;
  if (trend.length === 0) {
    return (
      <span className="text-muted-foreground flex-1 text-[10px]">
        no qualifying weeks
      </span>
    );
  }
  const max = Math.max(10, ...trend.map((t) => Math.abs(t.rel)));
  const x = (i: number) =>
    trend.length === 1 ? W / 2 : (i / (trend.length - 1)) * (W - 6) + 3;
  const y = (rel: number) => H / 2 - (rel / max) * (H / 2 - 2);
  const path = trend
    .map((t, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(t.rel)}`)
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-[18px] min-w-0 flex-1"
      role="img"
      aria-label="Relative weekly trend"
    >
      <line
        x1="0"
        x2={W}
        y1={H / 2}
        y2={H / 2}
        stroke="var(--border)"
        strokeWidth="0.5"
      />
      <path d={path} fill="none" stroke="var(--primary)" strokeWidth="1.2" />
      {trend.map((t, i) => (
        <circle key={t.weekStart} cx={x(i)} cy={y(t.rel)} r="1.6" fill="var(--primary)">
          <title>{`${new Date(t.weekStart).toLocaleDateString(undefined, { month: "short", day: "numeric" })}: ${t.rel >= 0 ? "+" : ""}${t.rel.toFixed(1)} vs roster`}</title>
        </circle>
      ))}
    </svg>
  );
}
