"use client";

import { api } from "@/lib/trpc-client";
import { wowClassColor, wowClassName } from "@/lib/wow";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Each character's current spec + a copyable talent code (Blizzard's compressed
 * loadout string). Raid leaders use these to detect off-meta builds and to
 * import the team's actual loadouts into sim tools.
 */
export function TalentLoadoutsWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  if (q.isPending) {
    return (
      <WidgetShell title="Talent loadouts">
        <WidgetLoading />
      </WidgetShell>
    );
  }
  if (q.error) {
    return (
      <WidgetShell title="Talent loadouts">
        <WidgetError message={q.error.message} />
      </WidgetShell>
    );
  }
  if (q.data.members.length === 0) {
    return (
      <WidgetShell title="Talent loadouts">
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      </WidgetShell>
    );
  }

  const rows = q.data.members
    .map((m) => ({
      ...m,
      spec: m.latest.character?.specName ?? null,
    }))
    .sort((a, b) => (a.spec ?? "").localeCompare(b.spec ?? ""));

  return (
    <WidgetShell
      title="Talent loadouts"
      description="Current spec per character (from the latest Tier A summary)."
    >
      <table className="w-full text-sm">
        <caption className="sr-only">Talent loadouts</caption>
        <thead>
          <tr className="text-muted-foreground text-left text-xs uppercase">
            <th scope="col" className="py-1 pr-3 font-medium">Character</th>
            <th scope="col" className="py-1 pr-3 font-medium">Class</th>
            <th scope="col" className="py-1 pr-3 font-medium">Spec</th>
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
              <td className="text-muted-foreground py-1.5 pr-3">
                {m.spec ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </WidgetShell>
  );
}
