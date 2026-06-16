"use client";

import { api } from "@/lib/trpc-client";
import { wowClassColor } from "@/lib/wow";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Brez Economy — battle-rez usage on progression. From the deaths layer's
 * combat-resurrection casts (public WCL logs): rezzes spent per boss + per
 * pull, a success rate (rezzed and survived the pull vs wasted on a doomed
 * pull), who PROVIDES the brezzes (so brez duty isn't on one person), and who
 * needs them most. The widget never spends WCL points.
 */

const diffShort = (d: number): string =>
  ({ 5: "M", 4: "H", 3: "N", 1: "L" })[d] ?? `${d}`;

const DESC =
  "Battle-rez economy — rezzes spent per boss + per pull, success rate, and who provides vs needs them. From public WCL logs.";

export function BrezEconomyWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.brezEconomy.useQuery({ raidTeamId });

  if (q.isPending) {
    return (
      <WidgetShell title="Brez economy" description={DESC}>
        <WidgetLoading />
      </WidgetShell>
    );
  }
  if (q.error) {
    return (
      <WidgetShell title="Brez economy" description={DESC}>
        <WidgetError message={q.error.message} />
      </WidgetShell>
    );
  }
  if (q.data.encounters.length === 0) {
    return (
      <WidgetShell title="Brez economy" description={DESC}>
        <WidgetEmpty>
          No battle-rezzes logged on wipes yet. This fills in from the guild&apos;s
          public WCL logs as progression is logged.
        </WidgetEmpty>
      </WidgetShell>
    );
  }

  const { encounters, rezzers, rezzed, totalRezzes, successRate, memberMeta, encounterNames } =
    q.data;
  const name = (cid: string) => memberMeta[cid]?.name ?? "Unknown";
  const color = (cid: string) => wowClassColor(memberMeta[cid]?.classId);

  return (
    <WidgetShell title="Brez economy" description={DESC}>
      <div className="mb-2 flex flex-wrap gap-3 text-xs">
        <span className="inline-flex items-center gap-1">
          <span className="font-semibold tabular-nums">{totalRezzes}</span>
          <span className="text-muted-foreground">brezzes on wipes</span>
        </span>
        {successRate != null && (
          <span className="inline-flex items-center gap-1">
            <span
              className={`font-semibold tabular-nums ${successRate >= 50 ? "text-emerald-500" : "text-amber-500"}`}
              title="Rezzed and survived the pull, vs wasted on a doomed pull (the target died again)"
            >
              {Math.round(successRate)}%
            </span>
            <span className="text-muted-foreground">survived the rez</span>
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-border border-b text-left uppercase">
              <th className="py-1 pr-2 font-medium">Boss</th>
              <th className="py-1 pr-2 text-right font-medium">Wipes</th>
              <th className="py-1 pr-2 text-right font-medium">Brezzes</th>
              <th className="py-1 pr-2 text-right font-medium">/pull</th>
              <th className="py-1 pl-2 text-right font-medium">Survived</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {encounters.map((e) => (
              <tr key={`${e.encounterId}|${e.difficulty}`}>
                <th scope="row" className="max-w-[10rem] truncate py-1 pr-2 text-left font-medium">
                  {encounterNames[e.encounterId] ?? `Encounter ${e.encounterId}`}{" "}
                  <span className="text-muted-foreground/60">{diffShort(e.difficulty)}</span>
                </th>
                <td className="py-1 pr-2 text-right tabular-nums">{e.wipePulls}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{e.rezzes}</td>
                <td className="py-1 pr-2 text-right tabular-nums">
                  {e.rezzesPerPull.toFixed(1)}
                </td>
                <td className="py-1 pl-2 text-right tabular-nums">
                  {e.rezzes > 0 ? `${Math.round((e.successful / e.rezzes) * 100)}%` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-3 text-xs">
        <Leaderboard
          title="Brez providers"
          rows={rezzers}
          name={name}
          color={color}
          empty="No rezzers identified"
        />
        <Leaderboard
          title="Most rezzed"
          rows={rezzed}
          name={name}
          color={color}
          empty="Nobody rezzed"
        />
      </div>
      <p className="text-muted-foreground mt-1.5 text-[10px]">
        {q.data.source.name}
        {q.data.source.isOverride ? " (team source)" : ""}. Survived = the rez
        landed and the target didn&apos;t die again that pull.
      </p>
    </WidgetShell>
  );
}

function Leaderboard({
  title,
  rows,
  name,
  color,
  empty,
}: {
  title: string;
  rows: Array<{ characterId: string; count: number }>;
  name: (cid: string) => string;
  color: (cid: string) => string;
  empty: string;
}) {
  return (
    <div>
      <p className="text-muted-foreground mb-0.5 font-medium uppercase">{title}</p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.slice(0, 5).map((r) => (
            <li key={r.characterId} className="flex justify-between gap-2">
              <span className="truncate font-medium" style={{ color: color(r.characterId) }}>
                {name(r.characterId)}
              </span>
              <span className="text-muted-foreground shrink-0 tabular-nums">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
