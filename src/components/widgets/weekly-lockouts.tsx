"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Weekly raid lockouts — bosses killed THIS reset per member, by
 * difficulty, with extended-lockout flag. Addon-only: the Blizzard web
 * API only exposes season aggregates, not the live weekly lockout.
 */
export function WeeklyLockoutsWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Weekly lockouts"
      description="Raid bosses cleared this reset. Needs the in-game uploader."
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
            Raid lockout progress per character this reset
          </caption>
          <thead>
            <tr className="border-border text-muted-foreground border-b text-xs uppercase">
              <th scope="col" className="py-1 pr-3 text-left font-medium">
                Character
              </th>
              <th scope="col" className="py-1 pl-3 text-left font-medium">
                Raid lockouts
              </th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {q.data.members.map((m) => {
              const locks = m.latest.addon?.lockouts ?? [];
              return (
                <tr key={m.character.id}>
                  <th
                    scope="row"
                    className="max-w-[10rem] truncate py-1.5 pr-3 text-left align-top font-medium"
                  >
                    {m.character.name}
                  </th>
                  <td className="py-1.5 pl-3">
                    {locks.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="flex flex-col gap-1">
                        {locks.map((rl, idx) => (
                          <span key={idx} className="flex flex-wrap items-baseline gap-x-3">
                            <span className="text-muted-foreground min-w-[7rem] truncate">
                              {rl.raid}
                            </span>
                            {rl.diffs.map((d) => (
                              <span key={d.tier} className="tabular-nums">
                                <span className="text-muted-foreground text-xs">
                                  {d.tier === "Normal"
                                    ? "N"
                                    : d.tier === "Heroic"
                                      ? "H"
                                      : d.tier === "Mythic"
                                        ? "M"
                                        : "LFR"}
                                </span>{" "}
                                {d.prog == null ? (
                                  <span className="text-muted-foreground">–</span>
                                ) : (
                                  <span
                                    className={
                                      d.prog.total > 0 &&
                                      d.prog.killed >= d.prog.total
                                        ? "text-green-500 font-medium"
                                        : "text-foreground"
                                    }
                                  >
                                    {d.prog.killed}/{d.prog.total || "?"}
                                    {d.prog.extended && (
                                      <span
                                        className="text-amber-500"
                                        title="Extended"
                                      >
                                        {" "}
                                        ⤓
                                      </span>
                                    )}
                                  </span>
                                )}
                              </span>
                            ))}
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
