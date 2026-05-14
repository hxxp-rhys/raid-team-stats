"use client";

import { useMemo } from "react";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Inline SVG sparkline of iLvL over time for one character. Picks the first
 * tracked character of the team when no `config.characterId` is provided —
 * the edit UI will offer a character picker once we ship per-widget config.
 */
export function CharacterTimelineWidget({
  raidTeamId,
  characterId,
}: {
  raidTeamId: string;
  characterId?: string;
}) {
  // Resolve the team to find a default character.
  const team = api.snapshot.latestForTeam.useQuery({ raidTeamId });
  const resolvedCharacterId =
    characterId ?? team.data?.members[0]?.character.id ?? null;
  const charName = team.data?.members.find(
    (m) => m.character.id === resolvedCharacterId,
  )?.character.name;

  const timeline = api.snapshot.characterTimeline.useQuery(
    { characterId: resolvedCharacterId!, days: 60 },
    { enabled: !!resolvedCharacterId },
  );

  const path = useMemo(() => {
    if (!timeline.data || timeline.data.points.length === 0) return null;
    const points = timeline.data.points.filter((p) => p.itemLevel != null);
    if (points.length < 2) return null;
    const xs = points.map((_, i) => i);
    const ys = points.map((p) => p.itemLevel as number);
    const xMin = 0;
    const xMax = xs.length - 1;
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const width = 280;
    const height = 60;
    const sx = (x: number) =>
      xMax === xMin ? width / 2 : ((x - xMin) / (xMax - xMin)) * width;
    const sy = (y: number) =>
      yMax === yMin
        ? height / 2
        : height - ((y - yMin) / (yMax - yMin)) * (height - 4) - 2;
    return points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${sx(i)} ${sy(ys[i]!)}`)
      .join(" ");
  }, [timeline.data]);

  return (
    <WidgetShell
      title="Character timeline"
      description={
        charName ? `${charName} — iLvL over the last 60 days.` : "iLvL trend."
      }
    >
      {team.isPending || timeline.isPending ? (
        <WidgetLoading />
      ) : team.error ? (
        <WidgetError message={team.error.message} />
      ) : !resolvedCharacterId ? (
        <WidgetEmpty>No tracked characters yet.</WidgetEmpty>
      ) : !path ? (
        <WidgetEmpty>Not enough snapshots to draw a trend yet.</WidgetEmpty>
      ) : (
        <svg
          viewBox="0 0 280 60"
          width="100%"
          height="60"
          role="img"
          aria-label="iLvL trend"
        >
          <path
            d={path}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-primary"
          />
        </svg>
      )}
    </WidgetShell>
  );
}
