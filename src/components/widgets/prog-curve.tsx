"use client";

import { useMemo, useState } from "react";

import { api } from "@/lib/trpc-client";
import {
  decayChipOf,
  dedupePulls,
  isThrowaway,
  nightsOf,
  paceOf,
  progressOf,
  rollingBest,
  slopeOf,
  type Pull,
} from "@/lib/prog-curve";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Progression Curve — every pull on a boss as a progress dot with a
 * rolling-best line and trend slope (tab 1), plus a per-night pace view
 * with breaks and a descriptive late-night decay chip (tab 2). Data comes
 * from Guild Report Sync (public WCL logs ingested hourly) — the widget
 * itself never spends WCL points.
 */
export function ProgCurveWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.progressionPulls.useQuery({ raidTeamId });

  const [tab, setTab] = useState<"curve" | "pace">("curve");
  const [axis, setAxis] = useState<"fight" | "boss">("fight");
  const [includeThrowaways, setIncludeThrowaways] = useState(false);
  const [encounterSel, setEncounterSel] = useState<number | null>(null);
  const [difficultySel, setDifficultySel] = useState<number | null>(null);
  // Render-stable "now" for the staleness label (day-resolution, so a
  // per-mount snapshot is plenty; calling Date.now() in render is impure).
  const [mountedAt] = useState(() => Date.now());

  // Dedupe FIRST (duplicate logs corrupt every count), then derive the
  // boss/difficulty pickers from what actually exists in the data.
  const deduped = useMemo(
    () => (q.data ? dedupePulls(q.data.pulls) : []),
    [q.data],
  );

  const difficulties = useMemo(
    () => [...new Set(deduped.map((p) => p.difficulty))].sort((a, b) => b - a),
    [deduped],
  );
  const difficulty = difficultySel ?? difficulties[0] ?? null;

  const atDifficulty = useMemo(
    () => deduped.filter((p) => p.difficulty === difficulty),
    [deduped, difficulty],
  );

  // Boss list ordered by most recent activity; default = the boss the team
  // pulled last (that's the prog boss, in practice).
  const encounters = useMemo(() => {
    const lastSeen = new Map<number, number>();
    for (const p of atDifficulty) {
      lastSeen.set(
        p.encounterId,
        Math.max(lastSeen.get(p.encounterId) ?? 0, p.startAt),
      );
    }
    return [...lastSeen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  }, [atDifficulty]);
  const encounterId = encounterSel ?? encounters[0] ?? null;

  const bossPulls = useMemo(
    () =>
      atDifficulty
        .filter((p) => p.encounterId === encounterId)
        .sort((a, b) => a.startAt - b.startAt),
    [atDifficulty, encounterId],
  );
  const throwaways = useMemo(
    () => bossPulls.filter((p) => isThrowaway(p)),
    [bossPulls],
  );
  const shownPulls = includeThrowaways
    ? bossPulls
    : bossPulls.filter((p) => !isThrowaway(p));

  // The throwaway rule is widget-global: pace counts and the decay chip must
  // only see real attempts (end-of-night resets cluster in exactly the
  // final-hour bucket and would fake a "raid is tired" signal).
  const paceReal = useMemo(
    () => atDifficulty.filter((p) => !isThrowaway(p)),
    [atDifficulty],
  );
  const paceExcluded = atDifficulty.length - paceReal.length;

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
  if (q.data.reportCount === 0) {
    return (
      <Shell tab={tab} setTab={setTab}>
        <WidgetEmpty>
          No public Warcraft Logs reports found for this guild yet. Guild
          Report Sync checks hourly — once someone uploads a public log, pulls
          appear here automatically.
        </WidgetEmpty>
      </Shell>
    );
  }
  if (deduped.length === 0) {
    return (
      <Shell tab={tab} setTab={setTab}>
        <WidgetEmpty>
          Reports found, but no raid-encounter pulls in the last 8 weeks.
        </WidgetEmpty>
      </Shell>
    );
  }

  const names = q.data.encounterNames;
  const bossName = (id: number | null) =>
    id == null ? "—" : (names[id] ?? `Encounter ${id}`);
  const diffName = (d: number) =>
    ({ 5: "Mythic", 4: "Heroic", 3: "Normal", 1: "LFR" })[d] ?? `D${d}`;

  // Stale-data chip (GRS empty-state ladder tier c): the newest log being
  // old is itself information — say so rather than silently charting it.
  const newestAt = q.data.newestReportAt
    ? new Date(q.data.newestReportAt).getTime()
    : null;
  const staleDays = newestAt
    ? Math.floor((mountedAt - newestAt) / 86_400_000)
    : null;
  const staleNote =
    staleDays != null && staleDays > 7 ? (
      <p className="text-muted-foreground mb-1 text-[10px]">
        Newest public log is {staleDays} days old — recent raids may not be
        logged (or logged privately).
      </p>
    ) : null;

  const pickers = (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
      {/* Boss picker only affects the curve tab — pace aggregates the night. */}
      {tab === "curve" && (
        <select
          className="border-border bg-background rounded-md border px-1.5 py-1"
          value={encounterId ?? ""}
          onChange={(e) => setEncounterSel(Number(e.target.value))}
          aria-label="Boss"
        >
          {encounters.map((id) => (
            <option key={id} value={id}>
              {bossName(id)}
            </option>
          ))}
        </select>
      )}
      <select
        className="border-border bg-background rounded-md border px-1.5 py-1"
        value={difficulty ?? ""}
        onChange={(e) => {
          setDifficultySel(Number(e.target.value));
          setEncounterSel(null); // boss list changes with difficulty
        }}
        aria-label="Difficulty"
      >
        {difficulties.map((d) => (
          <option key={d} value={d}>
            {diffName(d)}
          </option>
        ))}
      </select>
      {tab === "curve" && (
        <>
          <select
            className="border-border bg-background rounded-md border px-1.5 py-1"
            value={axis}
            onChange={(e) => setAxis(e.target.value as "fight" | "boss")}
            aria-label="Progress axis"
            title="Fight % is phase-aware (intermissions count); Boss HP is raw health remaining."
          >
            <option value="fight">Fight %</option>
            <option value="boss">Boss HP</option>
          </select>
          {throwaways.length > 0 && (
            <button
              type="button"
              onClick={() => setIncludeThrowaways((v) => !v)}
              className="text-muted-foreground hover:text-foreground underline decoration-dotted"
              title="Resets and sub-25s mispulls are excluded from the trend by default."
            >
              {includeThrowaways
                ? "hide"
                : `${throwaways.length} excluded`}
            </button>
          )}
        </>
      )}
    </div>
  );

  return (
    <Shell tab={tab} setTab={setTab}>
      {pickers}
      {staleNote}
      {tab === "curve" ? (
        <CurveTab pulls={shownPulls} axis={axis} />
      ) : (
        <PaceTab pulls={paceReal} names={names} excluded={paceExcluded} />
      )}
    </Shell>
  );
}

function Shell({
  tab,
  setTab,
  children,
}: {
  tab: "curve" | "pace";
  setTab: (t: "curve" | "pace") => void;
  children: React.ReactNode;
}) {
  return (
    <WidgetShell
      title="Progression curve"
      description="Pull-by-pull progress + night pace, from the guild's public logs."
    >
      <div
        role="tablist"
        className="border-border mb-2 flex gap-1 border-b text-xs"
      >
        {(
          [
            ["curve", "Progression"],
            ["pace", "Night pace"],
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
      </div>
      {children}
    </WidgetShell>
  );
}

const W = 720;
const H = 220;
const PAD = { l: 30, r: 8, t: 8, b: 18 };

function CurveTab({ pulls, axis }: { pulls: Pull[]; axis: "fight" | "boss" }) {
  if (pulls.length === 0) {
    return <WidgetEmpty>No pulls on this boss yet.</WidgetEmpty>;
  }

  const values = pulls.map((p) => progressOf(p, axis));
  const best = rollingBest(values);
  const wipesOnly = pulls
    .filter((p) => !p.kill)
    .map((p) => progressOf(p, axis));
  const slope = slopeOf(wipesOnly);
  const nights = nightsOf(pulls);

  const x = (i: number) =>
    PAD.l +
    (pulls.length === 1
      ? (W - PAD.l - PAD.r) / 2
      : (i / (pulls.length - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v / 100) * (H - PAD.t - PAD.b);

  // Night boundaries as pull indexes (first pull of each night after the first).
  const nightStartIdx: number[] = [];
  let acc = 0;
  for (const n of nights.slice(0, -1)) {
    acc += n.length;
    nightStartIdx.push(acc);
  }

  const bestPath = best
    .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(v)}`)
    .join(" ");

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="Pull-by-pull progression"
      >
        {[0, 25, 50, 75, 100].map((g) => (
          <g key={g}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(g)}
              y2={y(g)}
              stroke="var(--border)"
              strokeWidth="0.5"
            />
            <text
              x={PAD.l - 4}
              y={y(g) + 3}
              textAnchor="end"
              fontSize="8"
              fill="var(--muted-foreground)"
            >
              {g}%
            </text>
          </g>
        ))}
        {nightStartIdx.map((idx) => (
          <line
            key={idx}
            x1={(x(idx - 1) + x(idx)) / 2}
            x2={(x(idx - 1) + x(idx)) / 2}
            y1={PAD.t}
            y2={H - PAD.b}
            stroke="var(--border)"
            strokeDasharray="3 3"
          />
        ))}
        <path d={bestPath} fill="none" stroke="var(--primary)" strokeWidth="1" opacity="0.5" />
        {pulls.map((p, i) => {
          const v = values[i]!;
          const label = `Pull ${i + 1} — ${p.kill ? "KILL" : `${v.toFixed(1)}%`} · ${Math.round(p.durationMs / 1000)}s${p.lastPhase ? ` · P${p.lastPhase}` : ""} · ${new Date(p.startAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
          return (
            <a
              key={`${p.reportCode}:${p.fightId}`}
              href={`https://www.warcraftlogs.com/reports/${p.reportCode}#fight=${p.fightId}`}
              target="_blank"
              rel="noreferrer"
            >
              <title>{label}</title>
              {p.kill ? (
                <text
                  x={x(i)}
                  y={y(100) + 4}
                  textAnchor="middle"
                  fontSize="11"
                  fill="var(--primary)"
                >
                  ★
                </text>
              ) : (
                <circle
                  cx={x(i)}
                  cy={y(v)}
                  r="2.5"
                  fill="var(--primary)"
                  opacity="0.85"
                />
              )}
            </a>
          );
        })}
      </svg>
      <p className="text-muted-foreground mt-1 text-[10px]">
        {pulls.length} pull{pulls.length === 1 ? "" : "s"} across{" "}
        {nights.length} night{nights.length === 1 ? "" : "s"}
        {slope != null && (
          <>
            {" "}
            · trend {slope >= 0 ? "+" : ""}
            {slope.toFixed(1)}%/pull over the last {Math.min(15, wipesOnly.length)}{" "}
            wipes
          </>
        )}{" "}
        · line = best-so-far · dashed = night break · click a dot for the log.
      </p>
    </div>
  );
}

function PaceTab({
  pulls,
  names,
  excluded,
}: {
  pulls: Pull[];
  names: Record<number, string>;
  excluded: number;
}) {
  const nights = nightsOf(pulls).slice(-6).reverse(); // newest first
  if (nights.length === 0) {
    return <WidgetEmpty>No raid nights in the window.</WidgetEmpty>;
  }
  return (
    <div className="space-y-2">
      {nights.map((night) => {
        const pace = paceOf(night);
        const chip = decayChipOf(night);
        const first = night[0]!;
        const start = first.startAt;
        const span = Math.max(1, pace.spanMs);
        return (
          <div key={first.startAt} className="border-border rounded-md border p-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
              <span className="font-medium">
                {new Date(start).toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
              </span>
              <span className="text-muted-foreground">
                {pace.pulls} pulls ·{" "}
                {(pace.spanMs / 3_600_000).toFixed(1)}h
                {pace.pullsPerHour != null &&
                  ` · ${pace.pullsPerHour.toFixed(1)} pulls/hr active`}
                {pace.breaks.length > 0 &&
                  ` · ${pace.breaks.length} break${pace.breaks.length === 1 ? "" : "s"}`}
              </span>
            </div>
            {/* Night timeline: pull ticks + grey break bands. */}
            <div className="bg-muted/40 relative mt-1.5 h-3 w-full overflow-hidden rounded-sm">
              {pace.breaks.map((b, i) => (
                <div
                  key={i}
                  className="bg-border/70 absolute inset-y-0"
                  style={{
                    left: `${((b.startAt - start) / span) * 100}%`,
                    width: `${((b.endAt - b.startAt) / span) * 100}%`,
                  }}
                  title="Break (>20 min between pulls)"
                />
              ))}
              {night.map((p) => (
                <div
                  key={`${p.reportCode}:${p.fightId}`}
                  className={`absolute inset-y-0 w-0.5 ${p.kill ? "bg-primary" : "bg-foreground/50"}`}
                  style={{ left: `${((p.startAt - start) / span) * 100}%` }}
                  title={`${names[p.encounterId] ?? `Encounter ${p.encounterId}`} — ${p.kill ? "kill" : "wipe"}`}
                />
              ))}
            </div>
            {chip && (
              <p
                className="text-muted-foreground mt-1 text-[10px]"
                title="Descriptive only — small nightly samples. Median pull progress on the night's most-pulled boss, final hour vs whole night."
              >
                Final hour on {names[chip.encounterId] ?? `Encounter ${chip.encounterId}`}:{" "}
                {chip.delta <= -5
                  ? `ran ${Math.abs(chip.delta).toFixed(0)}%-pts below the night median`
                  : chip.delta >= 5
                    ? `ran ${chip.delta.toFixed(0)}%-pts above the night median`
                    : "held steady vs the night median"}
                .
              </p>
            )}
          </div>
        );
      })}
      <p className="text-muted-foreground text-[10px]">
        Ticks = pulls (accent = kills), grey bands = breaks. Pace is
        descriptive — farm nights and prog nights read differently by design.
        {excluded > 0 &&
          ` ${excluded} reset/mispull${excluded === 1 ? "" : "s"} excluded across the 8-week window.`}
      </p>
    </div>
  );
}
