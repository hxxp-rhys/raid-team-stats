"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

const STALE_HOURS = 6;

function relative(date: Date | string, nowMs: number): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const mins = Math.round((nowMs - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function RosterFreshnessWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });
  // `Date.now()` is impure — capture it once at mount via useState's lazy
  // initializer so relative-time strings are consistent across all rows and
  // the render itself stays pure.
  const [nowMs] = useState(() => Date.now());

  return (
    <WidgetShell
      title="Roster freshness"
      description={`Last successful sync per character. >${STALE_HOURS}h is flagged.`}
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        <ul className="divide-border divide-y text-sm">
          {q.data.members.map((m) => {
            const ts = m.character.lastSyncedAt;
            const ageH = (nowMs - new Date(ts).getTime()) / 3_600_000;
            const stale = ageH > STALE_HOURS;
            return (
              <li
                key={m.character.id}
                className="flex items-baseline justify-between py-1.5"
              >
                <span className="font-medium">{m.character.name}</span>
                <span
                  className={
                    stale
                      ? "text-amber-400 font-mono text-xs"
                      : "text-muted-foreground font-mono text-xs"
                  }
                >
                  {relative(ts, nowMs)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetShell>
  );
}
