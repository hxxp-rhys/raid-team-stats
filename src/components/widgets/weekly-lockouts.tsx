"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Weekly raid lockouts — one column per raid, each cell showing the
 * member's Heroic & Mythic kill progress THIS reset (LFR/Normal omitted
 * by design). Addon-only: the Blizzard web API only exposes season
 * aggregates, not the live weekly lockout.
 */
type Prog = { killed: number; total: number; extended: boolean } | null;

function Diff({ label, p }: { label: "H" | "M"; p: Prog }) {
  if (p == null) {
    return (
      <span className="tabular-nums">
        <span className="text-muted-foreground text-xs">{label}</span>{" "}
        <span className="text-muted-foreground">–</span>
      </span>
    );
  }
  const done = p.total > 0 && p.killed >= p.total;
  return (
    <span className="tabular-nums">
      <span className="text-muted-foreground text-xs">{label}</span>{" "}
      <span className={done ? "text-green-500 font-medium" : "text-foreground"}>
        {p.killed}/{p.total || "?"}
        {p.extended && (
          <span className="text-amber-500" title="Extended">
            {" "}
            ⤓
          </span>
        )}
      </span>
    </span>
  );
}

export function WeeklyLockoutsWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Weekly lockouts"
      description="Heroic / Mythic bosses cleared this reset, per raid."
      requiresCompanion
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        (() => {
          // Raid columns = union of raid names across members, first-seen
          // order (the server already returns biggest raid first).
          const raids: string[] = [];
          for (const m of q.data.members) {
            for (const l of m.latest.addon?.lockouts ?? []) {
              if (!raids.includes(l.raid)) raids.push(l.raid);
            }
          }
          if (raids.length === 0) {
            return (
              <WidgetEmpty>
                No raid lockouts yet — the in-game uploader fills this once a
                member is saved to a raid this reset.
              </WidgetEmpty>
            );
          }
          const pick = (
            lockouts: { raid: string; diffs: { tier: string; prog: Prog }[] }[],
            raid: string,
            tier: "Heroic" | "Mythic",
          ): Prog => {
            const r = lockouts.find((l) => l.raid === raid);
            return r?.diffs.find((d) => d.tier === tier)?.prog ?? null;
          };
          return (
            <table className="w-full text-sm">
              <caption className="sr-only">
                Heroic/Mythic raid lockout progress per character this reset
              </caption>
              <thead>
                <tr className="border-border text-muted-foreground border-b text-xs uppercase">
                  <th scope="col" className="py-1 pr-3 text-left font-medium">
                    Character
                  </th>
                  {raids.map((r) => (
                    <th
                      key={r}
                      scope="col"
                      className="px-3 py-1 text-left font-medium"
                    >
                      {r}
                    </th>
                  ))}
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
                      {raids.map((r) => {
                        const h = pick(locks, r, "Heroic");
                        const my = pick(locks, r, "Mythic");
                        return (
                          <td key={r} className="px-3 py-1.5 align-top">
                            {h == null && my == null ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <span className="flex gap-x-3">
                                <Diff label="H" p={h} />
                                <Diff label="M" p={my} />
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          );
        })()
      )}
    </WidgetShell>
  );
}
