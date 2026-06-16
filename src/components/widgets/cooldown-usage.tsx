"use client";

import { useMemo, useState } from "react";

import { api } from "@/lib/trpc-client";
import { wowClassColor } from "@/lib/wow";
import { Modal } from "@/components/ui/modal";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Defensive Usage (cooldown_usage) — a browsable, filterable ledger of the
 * deaths in the raid team's WCL logs. Pick a raid (by date), boss, and pull
 * (all default to "All"), then click any death to open a verbose, data-driven
 * breakdown: the boss damage taken in the seconds before death, the defensives
 * that were active or pressed, and the healing received — enough for a raid
 * leader to judge skill issue vs external factor.
 */

const diffShort = (d: number): string =>
  ({ 5: "M", 4: "H", 3: "N", 1: "L" })[d] ?? `${d}`;

const DESC =
  "Browse deaths from the team's WCL logs by raid, boss, and pull — click a death for the damage, defensives, and healing around it.";

const fmtNum = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(0)}k`
      : `${n}`;
const fmtSecs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

type SelDeath = {
  reportCode: string;
  fightId: number;
  targetActorId: number;
  deathAtMs: number;
  player: string;
  classId: number | null;
  boss: string;
  pullLabel: string;
  killingAbilityName: string | null;
};

export function CooldownUsageWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.cooldownUsage.useQuery({ raidTeamId });
  const [raid, setRaid] = useState<string>("all");
  const [boss, setBoss] = useState<string>("all"); // encounterId or "all"
  const [pull, setPull] = useState<string>("all"); // `report|fightId` or "all"
  const [selected, setSelected] = useState<SelDeath | null>(null);
  const [initialized, setInitialized] = useState(false);

  const data = q.data;
  const members = data?.members ?? {};
  const encName = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of data?.encounters ?? []) m.set(e.encounterId, e.name);
    return m;
  }, [data]);
  const reportDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data?.reports ?? []) m.set(r.code, r.startAtMs);
    return m;
  }, [data]);

  // Boss options scoped to the selected raid; pull options scoped to raid+boss.
  const bossOptions = useMemo(() => {
    const ids = new Set<number>();
    for (const d of data?.deaths ?? []) {
      if (raid !== "all" && d.reportCode !== raid) continue;
      ids.add(d.encounterId);
    }
    return [...ids]
      .map((id) => ({ id, name: encName.get(id) ?? `Boss ${id}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, raid, encName]);

  // A boss is the only prerequisite for pull filtering. fightId is unique only
  // within a report, so the pull's value is a composite `report|fightId` key —
  // which lets "All raids" stay selected (pulls are date-labelled to disambiguate).
  const pullEnabled = boss !== "all";
  const pullOptions = useMemo(() => {
    if (!pullEnabled) return [];
    return (data?.fights ?? [])
      .filter((f) => String(f.encounterId) === boss && (raid === "all" || f.reportCode === raid))
      // Descending: most recent raid + highest pull number on top.
      .sort((a, b) => {
        const da = reportDate.get(a.reportCode) ?? 0;
        const db = reportDate.get(b.reportCode) ?? 0;
        if (da !== db) return db - da;
        return (b.pullNumber ?? 0) - (a.pullNumber ?? 0);
      })
      .map((f) => {
        const datePart =
          raid === "all"
            ? `${new Date(reportDate.get(f.reportCode) ?? 0).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · `
            : "";
        return {
          key: `${f.reportCode}|${f.fightId}`,
          label: `${datePart}Pull ${f.pullNumber ?? "?"}${
            f.kill ? " · kill" : f.bossPct != null ? ` · ${Math.round(f.bossPct)}%` : ""
          }`,
        };
      });
  }, [data, raid, boss, pullEnabled, reportDate]);

  const fights = useMemo(() => {
    const m = new Map<string, { pullNumber: number | null; kill: boolean }>();
    for (const f of data?.fights ?? [])
      m.set(`${f.reportCode}|${f.fightId}`, { pullNumber: f.pullNumber, kill: f.kill });
    return m;
  }, [data]);

  const deaths = useMemo(() => {
    const rows = (data?.deaths ?? []).filter((d) => {
      if (raid !== "all" && d.reportCode !== raid) return false;
      if (boss !== "all" && String(d.encounterId) !== boss) return false;
      if (pullEnabled && pull !== "all" && `${d.reportCode}|${d.fightId}` !== pull)
        return false;
      return true;
    });
    return rows;
  }, [data, raid, boss, pull, pullEnabled]);

  const covered = deaths.filter((d) => d.defensiveActiveName != null).length;

  // First time the data lands, default the filters to the most recent context:
  // latest raid → most recently-pulled boss → its most recent attempt. The most
  // recent DEATH pins all three (its report is the latest raid, its boss the
  // last one engaged, its fight the last death-bearing pull). Done during render
  // guarded by a flag, not an effect — the codebase avoids setState-in-effect.
  if (!initialized && data && data.deaths.length > 0) {
    const latestRaid = data.reports[0]?.code;
    const inRaid = latestRaid
      ? data.deaths.filter((d) => d.reportCode === latestRaid)
      : [];
    if (latestRaid && inRaid.length > 0) {
      const recent = inRaid.reduce((a, b) => (b.deathAtMs > a.deathAtMs ? b : a));
      setRaid(latestRaid);
      setBoss(String(recent.encounterId));
      setPull(`${recent.reportCode}|${recent.fightId}`);
    }
    setInitialized(true);
  }

  if (q.isPending)
    return (
      <WidgetShell title="Defensive usage" description={DESC}>
        <WidgetLoading />
      </WidgetShell>
    );
  if (q.error)
    return (
      <WidgetShell title="Defensive usage" description={DESC}>
        <WidgetError message={q.error.message} />
      </WidgetShell>
    );
  if (!data || data.deaths.length === 0)
    return (
      <WidgetShell title="Defensive usage" description={DESC}>
        <WidgetEmpty>
          No analyzed wipe deaths yet. This fills in from the team&apos;s public
          WCL logs as raids are synced.
        </WidgetEmpty>
      </WidgetShell>
    );

  const sel = (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        className="border-border bg-background max-w-[10rem] rounded-md border px-1.5 py-1 text-xs"
        value={raid}
        onChange={(e) => {
          setRaid(e.target.value);
          setBoss("all");
          setPull("all");
        }}
        aria-label="Raid"
      >
        <option value="all">All raids</option>
        {data.reports.map((r) => (
          <option key={r.code} value={r.code}>
            {new Date(r.startAtMs).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
            {r.title ? ` · ${r.title}` : ""}
          </option>
        ))}
      </select>
      <select
        className="border-border bg-background max-w-[9rem] rounded-md border px-1.5 py-1 text-xs"
        value={boss}
        onChange={(e) => {
          setBoss(e.target.value);
          setPull("all");
        }}
        aria-label="Boss"
      >
        <option value="all">All bosses</option>
        {bossOptions.map((b) => (
          <option key={b.id} value={String(b.id)}>
            {b.name}
          </option>
        ))}
      </select>
      <select
        className="border-border bg-background rounded-md border px-1.5 py-1 text-xs disabled:opacity-50"
        value={pull}
        onChange={(e) => setPull(e.target.value)}
        disabled={!pullEnabled}
        aria-label="Pull"
        title={pullEnabled ? "Pull" : "Pick a boss to filter by pull"}
      >
        <option value="all">{pullEnabled ? "All pulls" : "Pick a boss first"}</option>
        {pullOptions.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <WidgetShell title="Defensive usage" description={DESC} headerAction={sel}>
      <p className="text-muted-foreground mb-1 text-[10px]">
        {deaths.length} death{deaths.length === 1 ? "" : "s"} shown ·{" "}
        {covered}/{deaths.length} had a personal defensive up · click a row for
        the full breakdown.
      </p>
      <div className="max-h-[18rem] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground border-border sticky top-0 border-b bg-card text-left uppercase">
            <tr>
              <th className="py-1 pr-2 font-medium">Raider</th>
              {boss === "all" && <th className="py-1 pr-2 font-medium">Boss</th>}
              <th className="py-1 pr-2 font-medium">Pull</th>
              <th className="py-1 pr-2 text-center font-medium" title="Personal defensive active at death">
                Def
              </th>
              <th className="py-1 pr-2 font-medium">Killed by</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {deaths.slice(0, 200).map((d, i) => {
              const meta = members[d.characterId ?? ""];
              const bossName = encName.get(d.encounterId) ?? `Boss ${d.encounterId}`;
              const fm = fights.get(`${d.reportCode}|${d.fightId}`);
              const pullLabel = `${diffShort(d.difficulty)}${fm?.pullNumber ? ` #${fm.pullNumber}` : ""}`;
              return (
                <tr
                  key={`${d.reportCode}|${d.fightId}|${d.targetActorId}|${i}`}
                  className="hover:bg-muted/40 cursor-pointer"
                  onClick={() =>
                    setSelected({
                      reportCode: d.reportCode,
                      fightId: d.fightId,
                      targetActorId: d.targetActorId,
                      deathAtMs: d.deathAtMs,
                      player: meta?.name ?? "Unknown",
                      classId: meta?.classId ?? null,
                      boss: bossName,
                      pullLabel,
                      killingAbilityName: d.killingAbilityName,
                    })
                  }
                >
                  <td
                    className="max-w-[7rem] truncate py-1 pr-2 font-medium"
                    style={{ color: wowClassColor(meta?.classId) }}
                  >
                    {meta?.name ?? "Unknown"}
                  </td>
                  {boss === "all" && (
                    <td className="max-w-[7rem] truncate py-1 pr-2">{bossName}</td>
                  )}
                  <td className="py-1 pr-2 whitespace-nowrap tabular-nums">{pullLabel}</td>
                  <td className="py-1 pr-2 text-center">
                    {d.defensiveActiveName ? (
                      <span className="text-emerald-500" title={d.defensiveActiveName}>
                        ✓
                      </span>
                    ) : (
                      <span className="text-destructive/70" title="No personal defensive active">
                        ✗
                      </span>
                    )}
                  </td>
                  <td className="max-w-[8rem] truncate py-1 pr-2">
                    {d.killingAbilityName ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {deaths.length > 200 && (
          <p className="text-muted-foreground mt-1 text-center text-[10px]">
            Showing 200 of {deaths.length} — narrow with the filters above.
          </p>
        )}
      </div>
      <p className="text-muted-foreground mt-1.5 text-[10px]">
        {data.source.name}
        {data.source.isOverride ? " (team source)" : ""}. ✓ = a personal
        defensive was active at death — not always avoidable, a one-shot saves no
        one.
      </p>

      <DeathLightbox
        raidTeamId={raidTeamId}
        death={selected}
        onClose={() => setSelected(null)}
      />
    </WidgetShell>
  );
}

// ── Death-context lightbox (fetches the WCL window on demand) ─────────────────

function DeathLightbox({
  raidTeamId,
  death,
  onClose,
}: {
  raidTeamId: string;
  death: SelDeath | null;
  onClose: () => void;
}) {
  const q = api.snapshot.deathContext.useQuery(
    death
      ? {
          raidTeamId,
          reportCode: death.reportCode,
          fightId: death.fightId,
          targetActorId: death.targetActorId,
          deathAtMs: death.deathAtMs,
        }
      : {
          raidTeamId,
          reportCode: "",
          fightId: 0,
          targetActorId: 0,
          deathAtMs: 0,
        },
    { enabled: death != null, staleTime: 5 * 60_000, retry: false },
  );

  const ctx = q.data;
  return (
    <Modal
      open={death != null}
      onClose={onClose}
      title={death ? `${death.player} — ${death.boss}` : ""}
      description={death ? `${death.pullLabel} · killed by ${death.killingAbilityName ?? "unknown"}` : undefined}
      className="max-w-2xl"
      showCloseIcon
      hideDefaultFooter
    >
      {!death ? null : q.isPending ? (
        <p className="text-muted-foreground py-6 text-center text-sm">
          Fetching the seconds around this death from Warcraft Logs…
        </p>
      ) : q.error ? (
        <p className="text-destructive py-6 text-center text-sm">
          Couldn&apos;t load this death&apos;s context: {q.error.message}
        </p>
      ) : !ctx ? null : (
        <div className="space-y-4 text-sm">
          {/* Verdict band */}
          <div
            className={`rounded-md border p-2.5 ${
              ctx.fatal?.hadPersonalDefensive
                ? "border-emerald-500/40 bg-emerald-500/5"
                : "border-destructive/40 bg-destructive/5"
            }`}
          >
            <p className="font-medium">
              Killed by {ctx.fatal?.abilityName ?? death.killingAbilityName ?? "unknown"}
              {ctx.fatal?.sourceName ? ` (${ctx.fatal.sourceName})` : ""}
              {ctx.fatal && ctx.fatal.amount > 0 ? ` for ${fmtNum(ctx.fatal.amount)}` : ""}
              {ctx.fatal && ctx.fatal.overkill > 0 ? ` (${fmtNum(ctx.fatal.overkill)} overkill)` : ""}.
            </p>
            <p className="text-muted-foreground text-xs">
              {ctx.fatal?.hadPersonalDefensive
                ? "A personal defensive was active when the fatal hit landed."
                : "No personal defensive was active when the fatal hit landed."}
            </p>
          </div>

          {/* Headline state: was a defensive up at the fatal hit */}
          <p className="text-xs">
            <span className="text-muted-foreground">Defensive active at death: </span>
            {ctx.activeDefensives.length === 0 ? (
              <span className="text-destructive/80">none</span>
            ) : (
              ctx.activeDefensives.map((d) => (
                <Chip key={d.abilityId} tone={d.kind === "personal" ? "good" : "info"}>
                  {d.name}
                  {d.kind !== "personal" ? ` (${d.kind})` : ""}
                </Chip>
              ))
            )}
          </p>

          {/* One chronological timeline: damage, defensives used, healing */}
          <Section title={`Timeline (last ${Math.round(ctx.windowMs / 1000)}s)`}>
            {(() => {
              const evs: Array<
                | { k: "dmg"; ms: number; d: (typeof ctx.incoming)[number] }
                | { k: "cast"; ms: number; c: (typeof ctx.defensiveCasts)[number] }
                | { k: "heal"; ms: number; h: (typeof ctx.healingEvents)[number] }
              > = [
                ...ctx.incoming
                  .filter((d) => d.amount > 0 || d.absorbed > 0 || d.fatal)
                  .slice(-16)
                  .map((d) => ({ k: "dmg" as const, ms: d.msBeforeDeath, d })),
                ...ctx.defensiveCasts.map((c) => ({
                  k: "cast" as const,
                  ms: c.msBeforeDeath,
                  c,
                })),
                ...ctx.healingEvents.map((h) => ({
                  k: "heal" as const,
                  ms: h.msBeforeDeath,
                  h,
                })),
              ];
              // chronological: earliest (largest msBeforeDeath) first, death last
              evs.sort((a, b) => b.ms - a.ms);
              if (evs.length === 0)
                return (
                  <Muted>
                    No damage, defensives, or healing recorded in the window.
                  </Muted>
                );
              return (
                <ul className="space-y-0.5">
                  {evs.map((ev, i) => {
                    const time = (
                      <span className="text-muted-foreground w-9 shrink-0 text-[11px] tabular-nums">
                        -{fmtSecs(ev.ms)}
                      </span>
                    );
                    if (ev.k === "dmg") {
                      const d = ev.d;
                      return (
                        <li
                          key={i}
                          className={`bg-destructive/10 flex items-center gap-2 rounded px-1 py-0.5 ${
                            d.fatal ? "font-medium" : ""
                          }`}
                        >
                          {d.fatal ? (
                            <span
                              className="text-destructive flex w-9 shrink-0 items-center justify-center"
                              title={`Killing blow · -${fmtSecs(ev.ms)}`}
                              aria-label="Killing blow"
                            >
                              <Skull className="size-4" />
                            </span>
                          ) : (
                            time
                          )}
                          <Tag tone="dmg">DMG</Tag>
                          <span className="min-w-0 flex-1 truncate">
                            {d.abilityName ?? `Ability ${d.abilityId}`}
                            {d.sourceName ? ` · ${d.sourceName}` : ""}
                            {d.isAoE ? " (AoE)" : ""}
                            {d.fatal ? " — fatal" : ""}
                          </span>
                          <span className="text-destructive shrink-0 tabular-nums">
                            -{fmtNum(d.amount)}
                            {d.absorbed > 0 ? (
                              <span className="text-sky-500"> ({fmtNum(d.absorbed)} abs)</span>
                            ) : null}
                          </span>
                        </li>
                      );
                    }
                    if (ev.k === "cast") {
                      const c = ev.c;
                      return (
                        <li key={i} className="flex items-center gap-2 rounded px-1 py-0.5">
                          {time}
                          <Tag tone="def">DEF</Tag>
                          <span className="min-w-0 flex-1 truncate">
                            Used {c.name}
                            {!c.landed ? " (cancelled)" : ""}
                          </span>
                          <span className="shrink-0" />
                        </li>
                      );
                    }
                    const h = ev.h;
                    return (
                      <li key={i} className="flex items-center gap-2 rounded px-1 py-0.5">
                        {time}
                        <Tag tone="heal">HEAL</Tag>
                        <span className="min-w-0 flex-1 truncate">
                          {h.abilityName ?? "Heal"}
                          {h.sourceName ? ` · ${h.sourceName}` : ""}
                          {h.absorb ? " (absorb)" : ""}
                        </span>
                        <span className="shrink-0 text-emerald-600 tabular-nums dark:text-emerald-400">
                          +{fmtNum(h.amount)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              );
            })()}
            <Muted>
              Big single unmitigated hit = likely a one-shot / external; chunked
              down over several seconds with heals racing = more avoidable.
              {ctx.healing.count > 0
                ? ` ~${fmtNum(ctx.healing.total)} healing across ${ctx.healing.count} event${ctx.healing.count === 1 ? "" : "s"} in the window.`
                : " No healing landed in the window."}
            </Muted>
          </Section>

          <p className="text-muted-foreground border-border border-t pt-2 text-[10px]">
            Some deaths no cooldown would save (one-shots, fixates, assigned
            soaks). Use this to ask &ldquo;could they have lived?&rdquo;, not to
            conclude blame.
          </p>
        </div>
      )}
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-muted-foreground mb-1 text-[11px] font-semibold uppercase">
        {title}
      </p>
      {children}
    </div>
  );
}
function Tag({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "dmg" | "def" | "heal";
}) {
  const cls =
    tone === "dmg"
      ? "text-destructive"
      : tone === "def"
        ? "text-amber-500"
        : "text-emerald-500";
  return (
    <span className={`w-10 shrink-0 text-[9px] font-semibold tracking-wide ${cls}`}>
      {children}
    </span>
  );
}
function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-[11px]">{children}</p>;
}
// Inline skull (lucide paths) marking the killing blow — currentColor so it
// inherits text-destructive. Kept local to match this file's helper convention.
function Skull({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m12.5 17-.5-1-.5 1h1z" />
      <path d="M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="12" r="1" />
    </svg>
  );
}
function Chip({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "good" | "info" | "neutral";
}) {
  const cls =
    tone === "good"
      ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
      : tone === "info"
        ? "border-sky-500/40 text-sky-600 dark:text-sky-400"
        : "border-border text-muted-foreground";
  return (
    <span className={`mr-1 inline-block rounded-full border px-1.5 py-0.5 text-[10px] ${cls}`}>
      {children}
    </span>
  );
}
