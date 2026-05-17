"use client";

import { api } from "@/lib/trpc-client";
import { wowClassColor, wowClassName } from "@/lib/wow";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * "Did everyone run M+ this week?" view. Shows weekly run count and the
 * highest key timed. Vault-slot progress lives on the Great Vault widget.
 */
export function MplusWeeklyWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  if (q.isPending) {
    return (
      <WidgetShell title="M+ this week">
        <WidgetLoading />
      </WidgetShell>
    );
  }
  if (q.error) {
    return (
      <WidgetShell title="M+ this week">
        <WidgetError message={q.error.message} />
      </WidgetShell>
    );
  }
  if (q.data.members.length === 0) {
    return (
      <WidgetShell title="M+ this week">
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      </WidgetShell>
    );
  }

  const rows = q.data.members
    .map((m) => {
      // Exact weekly completions (repeats included) when available; fall
      // back to the per-dungeon best-runs array length for old snapshots.
      const runsRaw = m.latest.mplus?.runsThisWeek;
      const fallback = Array.isArray(runsRaw)
        ? runsRaw.length
        : typeof runsRaw === "number"
          ? runsRaw
          : 0;
      const runsCount = m.latest.mplus?.weeklyRunCount ?? fallback;
      const highest =
        typeof m.latest.mplus?.weeklyHighest === "number"
          ? m.latest.mplus.weeklyHighest
          : null;
      return { ...m, runsCount, highest };
    })
    .sort((a, b) => b.runsCount - a.runsCount);

  return (
    <WidgetShell
      title="M+ this week"
      description="Weekly M+ run count and the highest key timed. Vault-slot progress is on the Great Vault widget."
    >
      <table className="w-full text-sm">
        <caption className="sr-only">M+ progress this week</caption>
        <thead>
          <tr className="text-muted-foreground text-left text-xs uppercase">
            <th scope="col" className="py-1 pr-3 font-medium">Character</th>
            <th scope="col" className="py-1 pr-3 font-medium">Class</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Runs</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Highest</th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {rows.map((m) => (
            <tr key={m.character.id}>
              <td className="py-1.5 pr-3 font-medium">{m.character.name}</td>
              <td className="py-1.5 pr-3">
                <span style={{ color: wowClassColor(m.character.classId) }}>
                  {wowClassName(m.character.classId)}
                </span>
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">
                {m.runsCount}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">
                {m.highest ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </WidgetShell>
  );
}
