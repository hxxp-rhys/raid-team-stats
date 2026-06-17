"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Delve progression — season / tier / Valeera (companion) level per member.
 * PATCH(expansion): the delve-companion NAME is expansion-coupled (Brann in
 * The War Within → Valeera in Midnight) — update the label in the description
 * below each expansion. Delve data is entirely absent from the public APIs;
 * C_DelvesUI function names shift across 12.0.x, so the addon captures whatever
 * the live client exposes; this widget shows what came through, with a hint
 * when nothing did.
 */
export function DelveProgressWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Delve progress"
      description="Season / tier / Valeera (delve companion) level."
      requiresCompanion
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : q.data.members.every((m) => m.latest.addon?.delves == null) ? (
        <WidgetEmpty>
          No delve data yet — uploads from the in-game addon populate this once
          members run a delve and reload.
        </WidgetEmpty>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Delve progression per character</caption>
          <thead>
            <tr className="border-border text-muted-foreground border-b text-xs uppercase">
              <th scope="col" className="py-1 pr-3 text-left font-medium">
                Character
              </th>
              <th scope="col" className="px-2 py-1 text-center font-medium">
                Season
              </th>
              <th scope="col" className="px-2 py-1 text-center font-medium">
                Tier
              </th>
              <th scope="col" className="px-2 py-1 text-center font-medium">
                Valeera
              </th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {q.data.members.map((m) => {
              const d = m.latest.addon?.delves ?? null;
              const cell = (v: number | null | undefined) =>
                v == null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <span className="font-medium">{v}</span>
                );
              return (
                <tr key={m.character.id}>
                  <th
                    scope="row"
                    className="max-w-[10rem] truncate py-1.5 pr-3 text-left font-medium"
                  >
                    {m.character.name}
                  </th>
                  <td className="px-2 py-1.5 text-center tabular-nums">
                    {cell(d?.season)}
                  </td>
                  <td className="px-2 py-1.5 text-center tabular-nums">
                    {cell(d?.tier)}
                  </td>
                  <td className="px-2 py-1.5 text-center tabular-nums">
                    {cell(d?.companion)}
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
