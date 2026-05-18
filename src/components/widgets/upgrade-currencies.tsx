"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Gearing economy — catalyst charges + upgrade/seasonal currencies
 * (crests, valorstones, coffer keys, sparks, mettle) per member. None of
 * this is on any external API. Helps spot who's capped / sitting on crests.
 */
export function UpgradeCurrenciesWidget({
  raidTeamId,
}: {
  raidTeamId: string;
}) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Upgrade currencies"
      description="Catalyst + crests / valorstones / coffer keys per member. Needs the in-game uploader."
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">
            Upgrade currencies per character
          </caption>
          <thead>
            <tr className="border-border text-muted-foreground border-b text-xs uppercase">
              <th scope="col" className="py-1 pr-3 text-left font-medium">
                Character
              </th>
              <th scope="col" className="py-1 pl-3 text-left font-medium">
                Currencies
              </th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {q.data.members.map((m) => {
              const cur = m.latest.addon?.currencies ?? [];
              return (
                <tr key={m.character.id}>
                  <th
                    scope="row"
                    className="max-w-[10rem] truncate py-1.5 pr-3 text-left align-top font-medium"
                  >
                    {m.character.name}
                  </th>
                  <td className="py-1.5 pl-3">
                    {cur.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-x-3 gap-y-1">
                        {cur.map((c, idx) => (
                          <span key={idx} className="tabular-nums">
                            <span className="text-muted-foreground">
                              {c.name}
                            </span>{" "}
                            <span className="text-foreground font-medium">
                              {c.quantity ?? "?"}
                            </span>
                          </span>
                        ))}
                      </span>
                    )}
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
