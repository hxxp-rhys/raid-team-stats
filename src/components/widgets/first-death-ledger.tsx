"use client";

import { useMemo, useState } from "react";

import { api } from "@/lib/trpc-client";
import { wowClassColor } from "@/lib/wow";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * First-Death Ledger — who starts the wipes. Per boss, the team's players
 * ranked by first-death rate (how often they're the first to die on a wipe),
 * with early-death rate, deaths/pull, pulls observed, and their most common
 * killing ability. Click a player for their death-time histogram. Data comes
 * from the WCL deaths layer ingested by Guild Report Sync — the widget never
 * spends WCL points. "Who died first is almost always the most important
 * death", so rank leads with ORDER; the killing ability is context (it lies —
 * tiny ticking DoTs land the blow), shown but never the headline.
 */

const diffName = (d: number): string =>
  ({ 5: "Mythic", 4: "Heroic", 3: "Normal", 1: "LFR" })[d] ?? `D${d}`;

const fmtTime = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

type MemberRow = {
  characterId: string;
  pullsPresent: number;
  firstDeaths: number;
  earlyDeaths: number;
  deaths: number;
  firstDeathRate: number;
  earlyDeathRate: number;
  deathsPerPull: number;
  topKillingAbility: { name: string; count: number } | null;
  deathTimes: number[];
  killDeaths: number;
};

export function FirstDeathLedgerWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.firstDeathLedger.useQuery({ raidTeamId });
  const [difficultySel, setDifficultySel] = useState<number | null>(null);
  const [encounterSel, setEncounterSel] = useState<number | null>(null);
  const [openMember, setOpenMember] = useState<string | null>(null);

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
      <WidgetShell title="First-death ledger" description={DESC}>
        <WidgetLoading />
      </WidgetShell>
    );
  }
  if (q.error) {
    return (
      <WidgetShell title="First-death ledger" description={DESC}>
        <WidgetError message={q.error.message} />
      </WidgetShell>
    );
  }
  if (encounters.length === 0) {
    return (
      <WidgetShell title="First-death ledger" description={DESC}>
        <WidgetEmpty>
          No logged wipe pulls to analyze yet. First-death rankings appear once
          the team has at least 5 logged wipes on a boss — clean farm weeks
          stay empty by design.
        </WidgetEmpty>
      </WidgetShell>
    );
  }

  const names = q.data.encounterNames;
  const members = q.data.members;
  const bossName = (id: number | null) =>
    id == null ? "—" : (names[id] ?? `Encounter ${id}`);

  const selector = (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <select
        className="border-border bg-background rounded-md border px-1.5 py-1"
        value={encounterId ?? ""}
        onChange={(e) => {
          setEncounterSel(Number(e.target.value));
          setOpenMember(null);
        }}
        aria-label="Boss"
      >
        {atDifficulty.map((e) => (
          <option key={e.encounterId} value={e.encounterId}>
            {bossName(e.encounterId)} ({e.wipePulls})
          </option>
        ))}
      </select>
      <select
        className="border-border bg-background rounded-md border px-1.5 py-1"
        value={difficulty ?? ""}
        onChange={(e) => {
          setDifficultySel(Number(e.target.value));
          setEncounterSel(null);
          setOpenMember(null);
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
    <WidgetShell title="First-death ledger" description={DESC} headerAction={selector}>
      {encounter ? (
        <LedgerBody
          encounter={encounter}
          members={members}
          openMember={openMember}
          setOpenMember={setOpenMember}
        />
      ) : (
        <WidgetEmpty>Pick a boss to see who starts the wipes.</WidgetEmpty>
      )}
      <SourceNote source={q.data.source} reportCount={q.data.reportCount} />
    </WidgetShell>
  );
}

const DESC =
  "Who starts the wipes — first-death and early-death rates per player across a boss's pulls, from the guild's public WCL logs.";

function LedgerBody({
  encounter,
  members,
  openMember,
  setOpenMember,
}: {
  encounter: {
    encounterId: number;
    difficulty: number;
    wipePulls: number;
    observedWipePulls: number;
    killPulls: number;
    members: MemberRow[];
  };
  members: Record<string, { name: string; classId: number | null }>;
  openMember: string | null;
  setOpenMember: (id: string | null) => void;
}) {
  const rows = encounter.members;
  if (rows.length === 0) {
    return (
      <WidgetEmpty>
        No player was present for enough observed wipes here yet (need 5+).
      </WidgetEmpty>
    );
  }
  const maxRate = Math.max(0.0001, ...rows.map((r) => r.firstDeathRate));
  const coverageNote =
    encounter.observedWipePulls < encounter.wipePulls
      ? ` · rates over ${encounter.observedWipePulls} of ${encounter.wipePulls} wipes (deaths still backfilling)`
      : "";

  return (
    <div className="min-w-0">
      <p className="text-muted-foreground mb-1 text-[10px]">
        {encounter.wipePulls} wipes · {encounter.killPulls} kills · first-death
        rate per 10 pulls{coverageNote}
      </p>
      <ul className="space-y-1">
        {rows.map((r, i) => {
          const meta = members[r.characterId];
          const name = meta?.name ?? "Unknown";
          const color = wowClassColor(meta?.classId);
          const open = openMember === r.characterId;
          return (
            <li key={r.characterId} className="min-w-0">
              <button
                type="button"
                onClick={() => setOpenMember(open ? null : r.characterId)}
                className="hover:bg-muted/40 flex w-full items-center gap-2 rounded px-1 py-0.5 text-left"
                title="Click for this player's death-time histogram"
              >
                <span className="text-muted-foreground w-4 shrink-0 text-right text-[10px] tabular-nums">
                  {i + 1}
                </span>
                <span
                  className="w-24 shrink-0 truncate text-xs font-medium"
                  style={{ color }}
                >
                  {name}
                </span>
                {/* First-death rate bar (the headline). */}
                <span className="bg-muted relative h-3.5 min-w-0 flex-1 overflow-hidden rounded-sm">
                  <span
                    className="absolute inset-y-0 left-0 rounded-sm bg-rose-500/80"
                    style={{ width: `${(r.firstDeathRate / maxRate) * 100}%` }}
                  />
                  <span className="absolute inset-y-0 left-1 flex items-center text-[10px] font-semibold tabular-nums text-foreground/90">
                    {r.firstDeathRate.toFixed(1)}
                  </span>
                </span>
                {/* Context columns. */}
                <span className="text-muted-foreground hidden w-12 shrink-0 text-right text-[10px] tabular-nums sm:inline">
                  {r.earlyDeathRate.toFixed(1)} early
                </span>
                <span className="text-muted-foreground hidden w-14 shrink-0 text-right text-[10px] tabular-nums md:inline">
                  {r.deathsPerPull.toFixed(2)}/pull
                </span>
                <span className="text-muted-foreground hidden w-10 shrink-0 text-right text-[10px] tabular-nums sm:inline">
                  {r.pullsPresent}pp
                </span>
                <span className="text-muted-foreground hidden w-28 shrink-0 truncate text-right text-[10px] lg:inline">
                  {r.topKillingAbility
                    ? `${r.topKillingAbility.name}`
                    : "—"}
                </span>
              </button>
              {open && <DeathHistogram row={r} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Per-player death-time histogram — when in the pull this player tends to die. */
function DeathHistogram({ row }: { row: MemberRow }) {
  const times = row.deathTimes;
  if (times.length === 0) {
    return (
      <p className="text-muted-foreground px-7 py-1 text-[10px]">
        No deaths recorded on observed wipes — this player tends to survive.
      </p>
    );
  }
  const BINS = 10;
  const max = Math.max(...times);
  const binMs = Math.max(1, Math.ceil(max / BINS));
  const counts = new Array(BINS).fill(0) as number[];
  for (const t of times) {
    counts[Math.min(BINS - 1, Math.floor(t / binMs))]!++;
  }
  const peak = Math.max(1, ...counts);
  return (
    <div className="px-7 py-1">
      <div className="flex items-end gap-0.5" style={{ height: 36 }}>
        {counts.map((c, i) => (
          <span
            key={i}
            className="flex-1 rounded-sm bg-rose-500/60"
            style={{ height: `${(c / peak) * 100}%` }}
            title={`${fmtTime(i * binMs)}–${fmtTime((i + 1) * binMs)}: ${c} death${c === 1 ? "" : "s"}`}
          />
        ))}
      </div>
      <div className="text-muted-foreground mt-0.5 flex justify-between text-[9px]">
        <span>pull start</span>
        <span>
          {row.deaths} death{row.deaths === 1 ? "" : "s"} ·{" "}
          {row.killDeaths > 0 ? `${row.killDeaths} on kills · ` : ""}
          {fmtTime(max)} latest
        </span>
      </div>
    </div>
  );
}

function SourceNote({
  source,
  reportCount,
}: {
  source: { name: string; isOverride: boolean };
  reportCount: number;
}) {
  return (
    <p className="text-muted-foreground mt-1.5 text-[10px]">
      {reportCount} log{reportCount === 1 ? "" : "s"} from {source.name}
      {source.isOverride ? " (team source)" : ""}.
    </p>
  );
}
