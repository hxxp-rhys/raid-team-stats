"use client";

import { api } from "@/lib/trpc-client";
import { wowClassColor } from "@/lib/wow";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Engagement Pulse — characters × raid-weeks activity heatmap from the
 * VaultSnapshot weekly ledger, with a multi-signal churn watchlist.
 *
 * Reading rules baked into the UI: a missing week is "unknown", never
 * inactive; the in-progress week is hatched and excluded from baselines;
 * watchlist entries are conversation starters, not conclusions ("activity,
 * not attendance" — bench weeks look quiet by design).
 */
export function EngagementPulseWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.engagementPulse.useQuery({ raidTeamId });

  if (q.isPending) {
    return (
      <Shell>
        <WidgetLoading />
      </Shell>
    );
  }
  if (q.error) {
    return (
      <Shell>
        <WidgetError message={q.error.message} />
      </Shell>
    );
  }

  const { closedWeeks, rosterMedian, rosterMedianCurrent, members } = q.data;

  // Enough history to mean anything? (per spec: ≥2 closed raid weeks)
  const weeksWithData = closedWeeks.filter((_, i) =>
    members.some((m) => m.cells[i]?.score != null),
  ).length;
  if (members.length === 0 || weeksWithData < 2) {
    return (
      <Shell>
        <WidgetEmpty>
          Needs at least 2 closed raid weeks of vault history — the heatmap
          fills in as weekly syncs accumulate.
        </WidgetEmpty>
      </Shell>
    );
  }

  const watch = members.filter((m) => m.watchlisted);

  const weekLabel = (iso: string | Date) =>
    new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });

  return (
    <Shell>
      <div className="flex flex-col gap-3 lg:flex-row">
        {/* ---- heatmap ---- */}
        <div className="min-w-0 flex-1 overflow-x-auto">
          <table className="w-full border-separate border-spacing-0.5 text-xs">
            <thead>
              <tr>
                <th className="text-muted-foreground sticky left-0 bg-card pr-2 text-left font-normal">
                  {/* row label column */}
                </th>
                {closedWeeks.map((w) => (
                  <th
                    key={String(w)}
                    className="text-muted-foreground min-w-7 text-center font-normal"
                  >
                    {weekLabel(w)}
                  </th>
                ))}
                <th className="text-muted-foreground min-w-7 text-center font-normal italic">
                  now
                </th>
              </tr>
            </thead>
            <tbody>
              {/* roster-median lane */}
              <tr>
                <td className="text-muted-foreground sticky left-0 bg-card pr-2 italic">
                  Roster median
                </td>
                {rosterMedian.map((s, i) => (
                  <HeatCell key={i} score={s} median />
                ))}
                <HeatCell score={rosterMedianCurrent} median current />
              </tr>
              {members.map((m) => (
                <tr key={m.character.id}>
                  <td
                    className="sticky left-0 max-w-28 truncate bg-card pr-2 font-medium"
                    style={{ color: wowClassColor(m.character.classId) }}
                    title={`${m.character.name}${
                      m.baseline != null
                        ? ` — baseline ${m.baseline}/6 over prior weeks`
                        : ""
                    }`}
                  >
                    {m.decayFlagged && (
                      <span
                        className="text-destructive mr-1"
                        title="Activity decay: the last two closed weeks are at or below half this player's personal baseline."
                      >
                        ▼
                      </span>
                    )}
                    {m.character.name}
                  </td>
                  {m.cells.map((c, i) => (
                    <HeatCell
                      key={i}
                      score={c.score}
                      raid={c.raidUnlocked}
                      mplus={c.mplusUnlocked}
                      runs={c.mplusRuns}
                      raided={c.raided}
                    />
                  ))}
                  <HeatCell
                    score={m.current.score}
                    raid={m.current.raidUnlocked}
                    mplus={m.current.mplusUnlocked}
                    runs={m.current.mplusRuns}
                    raided={m.current.raided}
                    current
                  />
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-muted-foreground mt-1.5 text-[10px]">
            Cell = vault slots unlocked that raid week (top half raid 0–3,
            bottom half M+ 0–3). Grey hatch = no data (sync gap — unknown,
            not inactive). “now” is in progress and never counts toward
            decay. Dot = logged raid kill that week. Activity ≠ attendance:
            bench weeks look quiet.
          </p>
        </div>

        {/* ---- watchlist ---- */}
        <div className="shrink-0 lg:w-64">
          <p className="mb-1 text-xs font-medium">Watchlist</p>
          {watch.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              Nobody trips multiple churn signals right now.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {watch.map((m) => (
                <li
                  key={m.character.id}
                  className="border-border rounded-md border p-1.5"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className="truncate text-xs font-medium"
                      style={{ color: wowClassColor(m.character.classId) }}
                    >
                      {m.character.name}
                    </span>
                    <span className="text-muted-foreground text-[10px]">
                      risk {(m.risk * 100).toFixed(0)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {m.signals.activity > 0 && (
                      <Chip
                        tone={m.signals.activity >= 1 ? "bad" : "warn"}
                        title={
                          m.baseline != null
                            ? `Weekly activity vs personal baseline of ${m.baseline}/6`
                            : "Weekly activity decline"
                        }
                      >
                        activity ▼
                      </Chip>
                    )}
                    {m.signals.login > 0 && (
                      <Chip
                        tone={m.signals.login >= 1 ? "bad" : "warn"}
                        title="Days since last in-game login, as of the latest Blizzard snapshot (updates at logout and can lag for players whose gear/spec never changes — cross-checked against observed weekly activity)."
                      >
                        last login {m.daysSinceLogin}d ago
                      </Chip>
                    )}
                    {m.signals.mplus > 0 && (
                      <Chip
                        tone={m.signals.mplus >= 1 ? "bad" : "warn"}
                        title={`M+ ${m.currentRating ?? 0} now vs ${
                          m.previousSeasonRating ?? "?"
                        } in ${m.previousSeasonSlug ?? "previous season"}. If that season was in the prior expansion, early-season scores run structurally lower — supporting signal only.`}
                      >
                        M+ ↓ vs last season
                      </Chip>
                    )}
                    {m.signals.absence > 0 && (
                      <Chip
                        tone="warn"
                        title="Consecutive guild-roster syncs without this character"
                      >
                        {m.consecutiveAbsences}× absent
                      </Chip>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-muted-foreground mt-1.5 text-[10px]">
            Listed only when ≥2 independent signals agree. Check in — don’t
            conclude.
          </p>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <WidgetShell
      title="Engagement pulse"
      description="Weekly activity heatmap + churn early-warning, from vault history."
    >
      {children}
    </WidgetShell>
  );
}

/**
 * One heatmap cell. Member cells render two stacked halves — top tinted by
 * the raid share (0–3), bottom by the M+ share (0–3) — so a "3" from raiding
 * reads differently from a "3" from keys; the roster-median lane renders a
 * single intensity from the total (0–6). Unknown weeks render a diagonal
 * hatch — visually distinct from a true zero week.
 */
function HeatCell({
  score,
  raid,
  mplus,
  runs,
  raided,
  current,
  median,
}: {
  score: number | null;
  raid?: number | null;
  mplus?: number | null;
  runs?: number | null;
  raided?: boolean;
  current?: boolean;
  median?: boolean;
}) {
  const title =
    score == null
      ? median
        ? "No member had data for this week"
        : current
          ? "Week in progress — no data yet"
          : "No data for this week (sync gap) — unknown, not inactive"
      : median
        ? `Roster median: ${score}/6 vault slots`
        : `${score}/6 vault slots (raid ${raid ?? 0}/3, M+ ${mplus ?? 0}/3)` +
          (runs != null ? ` · ${runs} M+ run${runs === 1 ? "" : "s"}` : "") +
          (raided ? " · raid kill logged" : "");

  const intensity = (v: number, max: number) =>
    `color-mix(in srgb, var(--primary) ${Math.round(
      (Math.min(v, max) / max) * 85 + (v > 0 ? 15 : 4),
    )}%, transparent)`;

  // Member cells split top = raid share, bottom = M+ share, so a "3" from
  // raiding reads differently from a "3" from keys. The median lane has no
  // halves and renders a single intensity from the total.
  const splitHalves = score != null && !median;

  return (
    <td className="p-0" title={title}>
      <div
        className={`relative h-5 w-full min-w-6 overflow-hidden rounded-sm ${
          current ? "ring-border ring-1 ring-inset" : ""
        }`}
        style={
          score == null
            ? {
                backgroundImage:
                  "repeating-linear-gradient(45deg, transparent, transparent 3px, var(--border) 3px, var(--border) 4px)",
              }
            : splitHalves
              ? undefined
              : { backgroundColor: intensity(score, 6) }
        }
      >
        {splitHalves && (
          <div className="flex h-full w-full flex-col" aria-hidden>
            <div
              className="flex-1"
              style={{ backgroundColor: intensity(raid ?? 0, 3) }}
            />
            <div
              className="flex-1"
              style={{ backgroundColor: intensity(mplus ?? 0, 3) }}
            />
          </div>
        )}
        {raided && (
          <span
            className="bg-foreground absolute right-0.5 top-0.5 size-1 rounded-full"
            aria-hidden
          />
        )}
      </div>
    </td>
  );
}

function Chip({
  children,
  tone,
  title,
}: {
  children: React.ReactNode;
  tone: "bad" | "warn";
  title: string;
}) {
  return (
    <span
      title={title}
      className={`rounded-full border px-1.5 py-0.5 text-[10px] leading-none ${
        tone === "bad"
          ? "border-destructive/40 text-destructive"
          : "border-border text-muted-foreground"
      }`}
    >
      {children}
    </span>
  );
}
