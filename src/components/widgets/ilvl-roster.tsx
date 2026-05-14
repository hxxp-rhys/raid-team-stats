"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

export function IlvlRosterWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Item-level roster"
      description="Equipped iLvL per active member, most recent snapshot."
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">iLvL roster</caption>
          <thead>
            <tr className="text-muted-foreground text-left text-xs uppercase">
              <th scope="col" className="py-1 pr-3 font-medium">
                Character
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Realm
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Lvl
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                iLvL
              </th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {[...q.data.members]
              .sort(
                (a, b) =>
                  (b.latest.equipment?.itemLevel ?? b.latest.character?.itemLevel ?? 0) -
                  (a.latest.equipment?.itemLevel ?? a.latest.character?.itemLevel ?? 0),
              )
              .map((m) => {
                const ilvl =
                  m.latest.equipment?.itemLevel ??
                  m.latest.character?.itemLevel ??
                  null;
                return (
                  <tr key={m.character.id}>
                    <td className="py-1.5 pr-3 font-medium">{m.character.name}</td>
                    <td className="text-muted-foreground py-1.5 pr-3 text-xs">
                      {m.character.realmSlug}
                    </td>
                    <td className="text-muted-foreground py-1.5 pr-3 text-xs">
                      {m.character.level ?? "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono">
                      {ilvl ?? "—"}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      )}
    </WidgetShell>
  );
}
