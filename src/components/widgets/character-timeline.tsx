"use client";

import { useMemo, useState } from "react";

import { api } from "@/lib/trpc-client";
import { CHARACTER_TIMELINE_AVERAGE } from "@/lib/widgets/types";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

const DAYS = 60;
// SVG coordinate space (kept constant; the element scales to its cell via CSS).
const W = 280;
const H = 60;

const fmtDay = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * Inline SVG sparkline of iLvL over time for a raid team. A header selector
 * picks the series: the team "Average" (default) or a single character's
 * forward-filled iLvL. Plots against the real day axis so the line is
 * time-accurate, and scales in both dimensions to fill its grid cell. A subtle
 * y-axis gutter (max/min iLvL = the spread shown) and x-axis date range frame
 * the line so the magnitude is legible.
 *
 * `characterId` is the persisted default selection: a character cuid, the
 * "__average__" sentinel, or unset (the latter two both mean Average).
 */
export function CharacterTimelineWidget({
  raidTeamId,
  characterId,
}: {
  raidTeamId: string;
  characterId?: string;
}) {
  const timeline = api.snapshot.teamItemLevelTimeline.useQuery({
    raidTeamId,
    days: DAYS,
  });

  // Live selection: seed from the persisted default; "__average__" = Average.
  const [selection, setSelection] = useState<string>(
    characterId && characterId !== CHARACTER_TIMELINE_AVERAGE
      ? characterId
      : CHARACTER_TIMELINE_AVERAGE,
  );
  const isAverage = selection === CHARACTER_TIMELINE_AVERAGE;

  const characters = timeline.data?.characters ?? [];
  // Guard against a stale persisted/selected id no longer on the roster.
  const selectedExists =
    isAverage || characters.some((c) => c.id === selection);
  const effectiveSelection = selectedExists
    ? selection
    : CHARACTER_TIMELINE_AVERAGE;
  const effectiveIsAverage = effectiveSelection === CHARACTER_TIMELINE_AVERAGE;

  const selectedName = effectiveIsAverage
    ? "Team average"
    : characters.find((c) => c.id === effectiveSelection)?.name;

  const chart = useMemo(() => {
    const points = timeline.data?.points;
    if (!points || points.length === 0) return null;

    // Pull the chosen series as (dayMs, value) pairs, dropping unknown days.
    const series: Array<{ day: number; value: number }> = [];
    for (const p of points) {
      const value = effectiveIsAverage ? p.average : p.byChar[effectiveSelection];
      if (value != null) series.push({ day: Number(p.day), value });
    }
    if (series.length < 2) return null;

    const xs = series.map((s) => s.day);
    const ys = series.map((s) => s.value);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);

    // Scale against the REAL day axis (not array index) so spacing is
    // time-accurate.
    const sx = (x: number) =>
      xMax === xMin ? W / 2 : ((x - xMin) / (xMax - xMin)) * W;
    const sy = (y: number) =>
      yMax === yMin
        ? H / 2
        : H - ((y - yMin) / (yMax - yMin)) * (H - 4) - 2;

    const d = series
      .map((s, i) => `${i === 0 ? "M" : "L"} ${sx(s.day)} ${sy(s.value)}`)
      .join(" ");

    return { d, yMin, yMax, xMin, xMax };
  }, [timeline.data, effectiveSelection, effectiveIsAverage]);

  const selector = (
    <select
      className="border-border bg-background rounded-md border px-1.5 py-1 text-xs"
      value={effectiveSelection}
      onChange={(e) => setSelection(e.target.value)}
      aria-label="Character"
      disabled={timeline.isPending || characters.length === 0}
    >
      <option value={CHARACTER_TIMELINE_AVERAGE}>Average</option>
      {characters.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );

  return (
    <WidgetShell
      title="Character timeline"
      description={
        selectedName
          ? `${selectedName} — iLvL over the last ${DAYS} days.`
          : `iLvL over the last ${DAYS} days.`
      }
      headerAction={selector}
    >
      {timeline.isPending ? (
        <WidgetLoading />
      ) : timeline.error ? (
        <WidgetError message={timeline.error.message} />
      ) : characters.length === 0 ? (
        <WidgetEmpty>No tracked characters yet.</WidgetEmpty>
      ) : !chart ? (
        <WidgetEmpty>Not enough snapshots to draw a trend yet.</WidgetEmpty>
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex min-h-0 flex-1 gap-1.5">
            {/* y-axis: the iLvL spread the line covers (max top, min bottom) */}
            <div className="text-muted-foreground flex w-8 shrink-0 flex-col justify-between py-0.5 text-right text-[10px] tabular-nums">
              <span>{Math.round(chart.yMax)}</span>
              <span className="text-[9px] tracking-tight opacity-70">iLvL</span>
              <span>
                {chart.yMin === chart.yMax ? "" : Math.round(chart.yMin)}
              </span>
            </div>
            {/* the line */}
            <div className="relative min-w-0 flex-1">
              <svg
                viewBox={`0 0 ${W} ${H}`}
                width="100%"
                height="100%"
                preserveAspectRatio="none"
                role="img"
                aria-label={`iLvL trend, ${Math.round(chart.yMin)} to ${Math.round(
                  chart.yMax,
                )}`}
                className="block h-full w-full"
              >
                <path
                  d={chart.d}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                  className="text-primary"
                />
              </svg>
            </div>
          </div>
          {/* x-axis: the date range the line spans */}
          <div className="text-muted-foreground mt-1 flex justify-between pl-[38px] text-[10px] tabular-nums">
            <span>{fmtDay(chart.xMin)}</span>
            <span>{fmtDay(chart.xMax)}</span>
          </div>
        </div>
      )}
    </WidgetShell>
  );
}
