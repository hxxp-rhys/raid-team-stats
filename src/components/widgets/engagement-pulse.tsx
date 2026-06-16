"use client";

import { useMemo, useState } from "react";

import { api } from "@/lib/trpc-client";
import { wowClassColor } from "@/lib/wow";
import {
  concerningStreak,
  engagementComponents,
  engagementTrend,
  weeklyEngagementScore,
  type EngagementCell,
  type EngagementTrend,
} from "@/lib/engagement-pulse";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Engagement Pulse — the combined weighted engagement index (the "Pulse",
 * 0–100) and the raw metrics behind it, charted over the closed raid weeks.
 *
 * Two controls drive the view:
 *  - Metric: "Pulse" (combined) or "Raw metrics" (the components).
 *  - Player: "All" or one player. ("All" is only available for Pulse — raw
 *    metrics are always for a single player.)
 *
 * Pulse + All     → one Pulse line per player; right panel = the Watchlist
 *                   (every name, ⚠ if concerning, red ⚠ if concerning ≥3 weeks;
 *                   click a name to open their raw metrics + explanation).
 * Pulse + player  → that player's Pulse line; right panel = their concerns.
 * Raw  + player   → that player's raw metric lines; right panel = their concerns.
 *
 * Framing contract (unchanged): ACTIVITY, not attendance; unobserved weeks are
 * GAPS, never zeros; the in-progress week is excluded; "check in — don't
 * conclude". A dot marks each observed week so sparse data is still visible.
 */

const TREND_GLYPH = { up: "▲", down: "▼", flat: "→" } as const;
const TREND_CLASS = {
  up: "text-emerald-500",
  down: "text-destructive",
  flat: "text-muted-foreground",
} as const;

const RAW_LEGEND: Array<{
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
}> = [
  { key: "index", label: "Pulse", color: "var(--foreground)", dashed: true },
  { key: "raid", label: "Raid vault", color: "var(--primary)" },
  { key: "kill", label: "Raid kill", color: "#10b981" },
  { key: "mvault", label: "M+ vault", color: "#38bdf8" },
  { key: "mruns", label: "M+ runs", color: "#f59e0b" },
];

type RawMember = {
  character: { id: string; name: string; classId: number | null };
  cells: EngagementCell[];
  watchlisted: boolean;
  decayFlagged: boolean;
  risk: number;
  daysSinceLogin: number | null;
  consecutiveAbsences: number;
  currentRating: number | null;
  previousSeasonRating: number | null;
  previousSeasonSlug: string | null;
  baseline: number | null;
  signals: { activity: number; login: number; mplus: number; absence: number };
};

type Concern = { label: string; detail: string };
type Level = "none" | "caution" | "critical";

type MemberView = RawMember & {
  scores: Array<number | null>;
  current: number | null;
  trend: EngagementTrend;
  concerns: Concern[];
  level: Level;
  concernWeeks: number;
};

type Mode = "combined" | "raw";

export function EngagementPulseWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.engagementPulse.useQuery({ raidTeamId });
  const [mode, setMode] = useState<Mode>("combined");
  const [playerId, setPlayerId] = useState<string | null>(null); // null = All
  const [hoverId, setHoverId] = useState<string | null>(null);

  const view = useMemo(() => {
    if (!q.data) return null;
    const closedWeeks = q.data.closedWeeks as Array<string | Date>;
    const members: MemberView[] = (q.data.members as unknown as RawMember[]).map(
      (m) => {
        const scores = m.cells.map((c) => weeklyEngagementScore(c));
        const observed = scores.filter((s): s is number => s != null);
        const current = observed.length ? observed[observed.length - 1]! : null;
        const trend = engagementTrend(scores);

        const concerns: Concern[] = [];
        if (m.signals.activity > 0)
          concerns.push({
            label: "Activity decay",
            detail: `Weekly activity has fallen to about half or less of their usual${
              m.baseline != null ? ` (baseline ${m.baseline}/6 vault slots)` : ""
            }.`,
          });
        if (m.signals.login > 0)
          concerns.push({
            label: "No recent login",
            detail: `No in-game login for ${m.daysSinceLogin ?? "?"} days (cross-checked against weekly activity).`,
          });
        if (m.signals.mplus > 0)
          concerns.push({
            label: "Mythic+ drop-off",
            detail: `M+ rating ${m.currentRating ?? 0} is well below last season's ${
              m.previousSeasonRating ?? "?"
            }${m.previousSeasonSlug ? ` (${m.previousSeasonSlug})` : ""}.`,
          });
        if (m.signals.absence > 0)
          concerns.push({
            label: "Roster absence",
            detail: `Missing from ${m.consecutiveAbsences} consecutive guild roster sync${
              m.consecutiveAbsences === 1 ? "" : "s"
            }.`,
          });
        if (trend.dir === "down")
          concerns.push({
            label: "Falling Pulse",
            detail: `Combined engagement is trending down${
              trend.delta != null ? ` by ${Math.abs(trend.delta)} pts` : ""
            } over recent weeks.`,
          });

        const isConcerning =
          m.watchlisted || m.decayFlagged || trend.dir === "down" || concerns.length > 0;
        const concernWeeks = concerningStreak(scores);
        const level: Level = !isConcerning
          ? "none"
          : concernWeeks >= 3
            ? "critical"
            : "caution";

        return { ...m, scores, current, trend, concerns, level, concernWeeks };
      },
    );
    return { closedWeeks, members };
  }, [q.data]);

  if (q.isPending)
    return (
      <Shell>
        <WidgetLoading />
      </Shell>
    );
  if (q.error)
    return (
      <Shell>
        <WidgetError message={q.error.message} />
      </Shell>
    );
  if (!view) return null;

  const weeksWithData = view.closedWeeks.filter((_, i) =>
    view.members.some((m) => m.scores[i] != null),
  ).length;
  if (view.members.length === 0 || weeksWithData < 1) {
    return (
      <Shell>
        <WidgetEmpty>
          No closed-week activity yet — the trend fills in as weekly syncs
          accumulate.
        </WidgetEmpty>
      </Shell>
    );
  }

  // Concern-first ordering for the watchlist + a sensible default player.
  const concernRank = (m: MemberView) =>
    m.level === "critical" ? 0 : m.level === "caution" ? 1 : 2;
  const byConcern = [...view.members].sort(
    (a, b) => concernRank(a) - concernRank(b) || a.character.name.localeCompare(b.character.name),
  );
  const byName = [...view.members].sort((a, b) =>
    a.character.name.localeCompare(b.character.name),
  );
  const defaultPlayerId = byConcern[0]?.character.id ?? null;

  const selectMode = (m: Mode) => {
    setMode(m);
    if (m === "raw" && playerId == null) setPlayerId(defaultPlayerId);
  };
  const openPlayerRaw = (id: string) => {
    setMode("raw");
    setPlayerId(id);
  };

  const selected =
    playerId != null
      ? (view.members.find((m) => m.character.id === playerId) ?? null)
      : null;
  // Raw mode is always per-player; fall back if somehow unset.
  const effective = mode === "raw" && !selected ? byConcern[0] ?? null : selected;

  const weekLabels = view.closedWeeks.map((w) =>
    new Date(w).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  );

  const controls = (
    <div className="flex items-center gap-1.5">
      <select
        className="border-border bg-background rounded-md border px-1.5 py-1 text-xs"
        value={mode}
        onChange={(e) => selectMode(e.target.value as Mode)}
        aria-label="Metric"
      >
        <option value="combined">Pulse</option>
        <option value="raw">Raw metrics</option>
      </select>
      <select
        className="border-border bg-background max-w-[9rem] rounded-md border px-1.5 py-1 text-xs"
        value={effective?.character.id ?? "all"}
        onChange={(e) =>
          setPlayerId(e.target.value === "all" ? null : e.target.value)
        }
        aria-label="Player"
      >
        {mode === "combined" && <option value="all">All players</option>}
        {byName.map((m) => (
          <option key={m.character.id} value={m.character.id}>
            {m.character.name}
          </option>
        ))}
      </select>
    </div>
  );

  // ---- build chart series for the active view ----
  let series: ChartSeries[];
  if (mode === "combined" && !effective) {
    // Pulse + All — one per-player line (no overall/aggregate line).
    series = view.members.map((m) => ({
      key: m.character.id,
      color: wowClassColor(m.character.classId),
      values: m.scores,
      width: hoverId === m.character.id ? 2.6 : m.level !== "none" ? 1.8 : 1.4,
      opacity:
        hoverId === m.character.id
          ? 1
          : m.level !== "none"
            ? 0.8
            : hoverId
              ? 0.14
              : 0.45,
    }));
  } else if (mode === "combined" && effective) {
    // Pulse + one player
    series = [
      {
        key: effective.character.id,
        color: wowClassColor(effective.character.classId),
        values: effective.scores,
        width: 2.6,
        opacity: 1,
      },
    ];
  } else {
    // Raw + one player
    const comps = (effective?.cells ?? []).map((c) => engagementComponents(c));
    series = [
      { key: "index", color: "var(--foreground)", values: effective?.scores ?? [], width: 2.4, opacity: 0.85, dashed: true },
      { key: "raid", color: "var(--primary)", values: comps.map((c) => (c ? c.raidVault : null)), width: 1.6, opacity: 0.95 },
      { key: "kill", color: "#10b981", values: comps.map((c) => (c ? c.raided : null)), width: 1.6, opacity: 0.95 },
      { key: "mvault", color: "#38bdf8", values: comps.map((c) => (c ? c.mplusVault : null)), width: 1.6, opacity: 0.95 },
      { key: "mruns", color: "#f59e0b", values: comps.map((c) => (c ? c.mplusRuns : null)), width: 1.6, opacity: 0.95 },
    ];
  }

  const showWatchlist = mode === "combined" && !effective;

  return (
    <Shell headerAction={controls}>
      <div className="flex flex-col gap-3 lg:flex-row">
        {/* ---- chart ---- */}
        <div className="min-w-0 flex-1">
          {effective && (
            <p
              className="mb-1 text-xs font-medium"
              style={{ color: wowClassColor(effective.character.classId) }}
            >
              {effective.character.name}
              <span className={`ml-2 font-normal ${TREND_CLASS[effective.trend.dir]}`}>
                {TREND_GLYPH[effective.trend.dir]}{" "}
                {effective.trend.dir === "up"
                  ? "rising"
                  : effective.trend.dir === "down"
                    ? "falling"
                    : "steady"}
                {effective.current != null ? ` · Pulse ${effective.current}` : ""}
              </span>
            </p>
          )}
          <TrendChart
            series={series}
            weekLabels={weekLabels}
            ariaLabel={
              mode === "raw"
                ? `${effective?.character.name ?? ""} raw metrics`
                : effective
                  ? `${effective.character.name} Pulse`
                  : "Pulse per player"
            }
          />
          {mode === "raw" ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {RAW_LEGEND.map((l) => (
                <span key={l.key} className="flex items-center gap-1 text-[10px]">
                  <span
                    className="inline-block h-2 w-3 rounded-sm"
                    style={{ backgroundColor: l.color, opacity: l.dashed ? 0.6 : 1 }}
                  />
                  {l.label}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground mt-1 text-[10px]">
              Each line is one player&apos;s Pulse — a weighted index 0–100 (raid
              vault 35% · logged kill 25% · M+ vault 25% · M+ runs 15%). Dots
              mark observed weeks; a line needs ≥2. In-progress week excluded;
              activity ≠ attendance.
            </p>
          )}
        </div>

        {/* ---- right panel ---- */}
        <div className="shrink-0 lg:w-64">
          {showWatchlist ? (
            <Watchlist
              members={byConcern}
              onHover={setHoverId}
              onPick={openPlayerRaw}
            />
          ) : (
            effective && <ConcernPanel member={effective} />
          )}
        </div>
      </div>
    </Shell>
  );
}

// ── Right panel: the watchlist (Pulse + All) ──────────────────────────────────

function Watchlist({
  members,
  onHover,
  onPick,
}: {
  members: MemberView[];
  onHover: (id: string | null) => void;
  onPick: (id: string) => void;
}) {
  const concerning = members.filter((m) => m.level !== "none").length;
  return (
    <div>
      <p className="mb-1 text-xs font-medium">
        Watchlist{" "}
        <span className="text-muted-foreground font-normal">
          ({concerning} flagged)
        </span>
      </p>
      <div className="max-h-56 overflow-y-auto pr-1">
        <ul className="space-y-0.5">
          {members.map((m) => (
            <li key={m.character.id}>
              <button
                className="hover:bg-muted/50 flex w-full items-center justify-between gap-2 rounded px-1 py-1 text-left"
                onMouseEnter={() => onHover(m.character.id)}
                onMouseLeave={() => onHover(null)}
                onClick={() => onPick(m.character.id)}
              >
                <span className="flex min-w-0 items-center gap-1">
                  <Badge level={m.level} weeks={m.concernWeeks} />
                  <span
                    className="truncate text-xs font-medium"
                    style={{ color: wowClassColor(m.character.classId) }}
                  >
                    {m.character.name}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
                  <span className="text-muted-foreground">
                    {m.current ?? "—"}
                  </span>
                  <span className={TREND_CLASS[m.trend.dir]}>
                    {TREND_GLYPH[m.trend.dir]}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-muted-foreground mt-1.5 text-[10px]">
        <span className="text-amber-500">⚠</span> concerning ·{" "}
        <span className="text-destructive">⚠</span> ≥3 weeks. Click a name for
        their metrics + why. Check in — don&apos;t conclude.
      </p>
    </div>
  );
}

function Badge({ level, weeks }: { level: Level; weeks: number }) {
  if (level === "critical")
    return (
      <span
        className="text-destructive shrink-0 text-xs font-bold"
        title={`Critical — concerning for ${weeks} weeks`}
      >
        ⚠
      </span>
    );
  if (level === "caution")
    return (
      <span className="shrink-0 text-xs text-amber-500" title="Caution — currently concerning">
        ⚠
      </span>
    );
  return <span className="text-muted-foreground/30 shrink-0 text-xs">·</span>;
}

// ── Right panel: per-player concern explanation ───────────────────────────────

function ConcernPanel({ member }: { member: MemberView }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <Badge level={member.level} weeks={member.concernWeeks} />
        <p className="text-xs font-medium">
          {member.level === "critical"
            ? `Critical — flagged ${member.concernWeeks} weeks`
            : member.level === "caution"
              ? "Worth a check-in"
              : "Looks healthy"}
        </p>
      </div>
      {member.concerns.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No concerning signals right now — their engagement metrics are within
          their normal range.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {member.concerns.map((c) => (
            <li key={c.label} className="border-border rounded-md border p-1.5">
              <p className="text-xs font-medium">{c.label}</p>
              <p className="text-muted-foreground text-[11px] leading-snug">
                {c.detail}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground mt-1.5 text-[10px]">
        Signals are conversation starters, not conclusions — a sync gap, bench
        week, or vacation can read the same way.
      </p>
    </div>
  );
}

// ── Inline-SVG multi-line chart (gaps for nulls, dots per observed week) ──────

type ChartSeries = {
  key: string;
  color: string;
  values: Array<number | null>;
  width: number;
  opacity: number;
  dashed?: boolean;
};

function TrendChart({
  series,
  weekLabels,
  ariaLabel,
}: {
  series: ChartSeries[];
  weekLabels: string[];
  ariaLabel: string;
}) {
  const n = weekLabels.length;
  const W = 560;
  const H = 190;
  const padL = 26;
  const padR = 8;
  const padT = 8;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const sx = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const sy = (v: number) =>
    padT + (1 - Math.min(Math.max(v, 0), 100) / 100) * plotH;

  // Connect ALL observed points into one continuous line — skip gap weeks but
  // keep the pen down so a player with data at non-consecutive weeks still
  // draws a line (the dots mark the actual observations). A single observed
  // week has no segment to draw, so its dot stands alone.
  const pathFor = (values: Array<number | null>) => {
    let d = "";
    let started = false;
    values.forEach((v, i) => {
      if (v == null) return;
      d += `${started ? "L" : "M"} ${sx(i).toFixed(1)} ${sy(v).toFixed(1)} `;
      started = true;
    });
    return d.trim();
  };

  const labelEvery = Math.max(1, Math.ceil(n / 6));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={ariaLabel}
      className="block w-full"
      style={{ aspectRatio: `${W} / ${H}` }}
    >
      {[0, 50, 100].map((g) => (
        <g key={g}>
          <line x1={padL} x2={W - padR} y1={sy(g)} y2={sy(g)} stroke="var(--border)" strokeWidth={0.5} />
          <text x={2} y={sy(g) + 3} fontSize={8} fill="var(--muted-foreground)">
            {g}
          </text>
        </g>
      ))}
      {weekLabels.map((lbl, i) =>
        i % labelEvery === 0 || i === n - 1 ? (
          <text key={i} x={sx(i)} y={H - 6} fontSize={8} textAnchor="middle" fill="var(--muted-foreground)">
            {lbl}
          </text>
        ) : null,
      )}
      {[...series]
        .sort((a, b) => a.opacity - b.opacity)
        .map((s) => {
          const d = pathFor(s.values);
          const dotR = s.width >= 2.4 ? 2.6 : 1.8;
          return (
            <g key={s.key}>
              {d && (
                <path
                  d={d}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.width}
                  strokeOpacity={s.opacity}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  strokeDasharray={s.dashed ? "4 3" : undefined}
                />
              )}
              {s.values.map((v, i) =>
                v == null ? null : (
                  <circle key={i} cx={sx(i)} cy={sy(v)} r={dotR} fill={s.color} fillOpacity={s.opacity} />
                ),
              )}
            </g>
          );
        })}
    </svg>
  );
}

function Shell({
  children,
  headerAction,
}: {
  children: React.ReactNode;
  headerAction?: React.ReactNode;
}) {
  return (
    <WidgetShell
      title="Engagement pulse"
      description="Weighted engagement index (Pulse) + raw-metric trends per player, with a churn watchlist."
      headerAction={headerAction}
    >
      {children}
    </WidgetShell>
  );
}
