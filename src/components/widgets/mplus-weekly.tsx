"use client";

import { api } from "@/lib/trpc-client";
import { wowClassColor, wowClassName } from "@/lib/wow";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * "Did everyone tap their vault this week?" view. Shows highest weekly key
 * and the M+ vault slots unlocked (1 run = slot 1, 4 runs = slot 2, 8 = slot 3).
 * Highlights members short of all three slots.
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

  const slotsUnlocked = (runs: number): 0 | 1 | 2 | 3 => {
    if (runs >= 8) return 3;
    if (runs >= 4) return 2;
    if (runs >= 1) return 1;
    return 0;
  };

  const rows = q.data.members
    .map((m) => {
      const runsRaw = m.latest.mplus?.runsThisWeek;
      const runsCount = Array.isArray(runsRaw)
        ? runsRaw.length
        : typeof runsRaw === "number"
          ? runsRaw
          : 0;
      const slots = slotsUnlocked(runsCount);
      const highest =
        typeof m.latest.mplus?.weeklyHighest === "number"
          ? m.latest.mplus.weeklyHighest
          : null;
      return { ...m, runsCount, slots, highest };
    })
    .sort((a, b) => b.slots - a.slots || b.runsCount - a.runsCount);

  return (
    <WidgetShell
      title="M+ this week"
      description="Vault tracks fill after 1/4/8 timed runs. Anyone under 8 leaves rewards on the table."
    >
      <table className="w-full text-sm">
        <caption className="sr-only">M+ progress this week</caption>
        <thead>
          <tr className="text-muted-foreground text-left text-xs uppercase">
            <th scope="col" className="py-1 pr-3 font-medium">Character</th>
            <th scope="col" className="py-1 pr-3 font-medium">Class</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Runs</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Highest</th>
            <th scope="col" className="py-1 pr-3 font-medium">Vault slots</th>
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
              <td className="py-1.5 pr-3">
                <SlotPips filled={m.slots} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </WidgetShell>
  );
}

function SlotPips({ filled }: { filled: 0 | 1 | 2 | 3 }) {
  return (
    <div className="flex gap-1" role="img" aria-label={`${filled} of 3 slots`}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`block h-3 w-3 rounded-sm ${
            i < filled ? "bg-primary" : "bg-muted"
          }`}
        />
      ))}
    </div>
  );
}
