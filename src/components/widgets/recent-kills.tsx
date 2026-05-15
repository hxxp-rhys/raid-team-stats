"use client";

import { useMemo, useState } from "react";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Most recent boss kills across the team, sorted by kill timestamp. Pulls
 * the `last_kill_timestamp` we capture in each RaidSnapshot's `completions`
 * array. The intended view: "what did the team accomplish in the last week".
 */

type CompletionEntry = {
  instanceName?: string | null;
  difficultyType?: string | null;
  encounters?: Array<{
    id?: number | null;
    name?: string | null;
    kills?: number;
    lastKillTimestamp?: number | null;
  }>;
};

type Row = {
  characterId: string;
  characterName: string;
  encounterName: string | null;
  instanceName: string | null;
  difficulty: string | null;
  killedAt: number;
  relative: string;
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function relativeTime(killedAt: number, nowMs: number): string {
  const diff = nowMs - killedAt;
  if (diff < 60 * 1000) return "just now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export function RecentKillsWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  // Captured once at mount via a useState lazy initializer so the render
  // function stays pure (Date.now() during render trips react-hooks/purity).
  const [now] = useState(() => Date.now());
  const cutoff = now - SEVEN_DAYS_MS;

  // Hooks must run on every render path — keep useMemo above early returns.
  const top = useMemo(() => {
    if (!q.data) return [] as Row[];
    const rows: Row[] = [];
    for (const m of q.data.members) {
      const entries =
        (m.latest.raid?.completions as CompletionEntry[] | null) ?? [];
      for (const e of entries) {
        for (const enc of e.encounters ?? []) {
          if (!enc.lastKillTimestamp || (enc.kills ?? 0) === 0) continue;
          if (enc.lastKillTimestamp < cutoff) continue;
          rows.push({
            characterId: m.character.id,
            characterName: m.character.name,
            encounterName: enc.name ?? null,
            instanceName: e.instanceName ?? null,
            difficulty: e.difficultyType ?? null,
            killedAt: enc.lastKillTimestamp,
            relative: relativeTime(enc.lastKillTimestamp, now),
          });
        }
      }
    }
    rows.sort((a, b) => b.killedAt - a.killedAt);
    return rows.slice(0, 30);
  }, [q.data, cutoff, now]);

  if (q.isPending) {
    return (
      <WidgetShell title="Recent kills">
        <WidgetLoading />
      </WidgetShell>
    );
  }
  if (q.error) {
    return (
      <WidgetShell title="Recent kills">
        <WidgetError message={q.error.message} />
      </WidgetShell>
    );
  }

  return (
    <WidgetShell
      title="Recent kills"
      description="Boss kills across the team in the last 7 days, newest first."
    >
      {top.length === 0 ? (
        <WidgetEmpty>No tracked kills in the last 7 days.</WidgetEmpty>
      ) : (
        <ul className="divide-border divide-y text-sm">
          {top.map((r, i) => (
            <li
              key={`${r.characterId}-${r.killedAt}-${i}`}
              className="flex items-baseline justify-between gap-3 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  <span className="font-medium">{r.characterName}</span>
                  <span className="text-muted-foreground"> killed </span>
                  <span className="font-medium">
                    {r.encounterName ?? "an encounter"}
                  </span>
                  {r.difficulty && (
                    <span className="text-muted-foreground">
                      {" "}
                      ({r.difficulty.slice(0, 1) +
                        r.difficulty.slice(1).toLowerCase()})
                    </span>
                  )}
                </p>
                {r.instanceName && (
                  <p className="text-muted-foreground text-xs">
                    {r.instanceName}
                  </p>
                )}
              </div>
              <span className="text-muted-foreground whitespace-nowrap text-xs">
                {r.relative}
              </span>
            </li>
          ))}
        </ul>
      )}
    </WidgetShell>
  );
}
