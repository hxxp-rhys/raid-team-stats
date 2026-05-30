"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * This week's M+ keystones — the key currently in each member's bag.
 * Addon-only: Blizzard / Raider.IO only expose completed runs, never the
 * held keystone. Great for scheduling the team's M+ night.
 */
export function KeystonesWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="This week's keystones"
      description="The keystone each member currently holds."
      requiresCompanion
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Held keystone per character</caption>
          <thead>
            <tr className="border-border text-muted-foreground border-b text-xs uppercase">
              <th scope="col" className="py-1 pr-3 text-left font-medium">
                Character
              </th>
              <th scope="col" className="py-1 pl-3 text-right font-medium">
                Keystone
              </th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {[...q.data.members]
              .map((m) => ({
                id: m.character.id,
                name: m.character.name,
                ks: m.latest.addon?.keystone ?? null,
              }))
              .sort((a, b) => (b.ks?.level ?? -1) - (a.ks?.level ?? -1))
              .map((row) => (
                <tr key={row.id}>
                  <th
                    scope="row"
                    className="max-w-[10rem] truncate py-1.5 pr-3 text-left font-medium"
                  >
                    {row.name}
                  </th>
                  <td className="py-1.5 pl-3 text-right tabular-nums">
                    {row.ks && (row.ks.mapName || row.ks.level != null) ? (
                      <span>
                        <span className="font-medium">
                          {row.ks.mapName ?? "Keystone"}
                        </span>
                        {row.ks.level != null && (
                          <span className="text-primary ml-1 font-mono">
                            +{row.ks.level}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </WidgetShell>
  );
}
