"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";
import {
  SortableHeader,
  useSortableColumns,
  type ColumnMap,
} from "./sortable-table";

type SortKey = "default" | "name" | "runs";

type KeyRow = {
  id: string;
  name: string;
  runs: Array<{ level: number | null; mapName?: string | null }>;
  /** Position in the default (most runs, then highest key) order. */
  defaultOrder: number;
};

const COLUMNS: ColumnMap<KeyRow, SortKey> = {
  // Non-header column reproducing the default most-runs-then-highest order.
  default: { key: "default", accessor: (r) => r.defaultOrder, kind: "number", defaultAsc: true },
  name: { key: "name", accessor: (r) => r.name, kind: "text" },
  runs: { key: "runs", accessor: (r) => r.runs.length, kind: "number" },
};

/**
 * This week's M+ runs — every Mythic+ run each member has COMPLETED this
 * reset (repeats included), highest key first. Addon-only: Blizzard /
 * Raider.IO only expose the deduped best-per-dungeon, not the exact run
 * list. Great for confirming who's done their keys for the week.
 *
 * `mapName` is null on today's addon (a future release adds it), so a run
 * gracefully renders as just "+{level}" until names arrive.
 */
export function KeystonesWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  const baseRows: KeyRow[] = [...(q.data?.members ?? [])]
    .map((m) => ({
      id: m.character.id,
      name: m.character.name,
      // weeklyRuns is already completed-only and sorted level-desc.
      runs: m.latest.addon?.weeklyRuns ?? [],
    }))
    // Members with the most (then highest) runs lead.
    .sort(
      (a, b) =>
        b.runs.length - a.runs.length ||
        (b.runs[0]?.level ?? -1) - (a.runs[0]?.level ?? -1),
    )
    .map((row, i) => ({ ...row, defaultOrder: i }));

  // Default: most runs, then highest key (frozen via defaultOrder).
  const {
    sorted: rows,
    sortKey,
    asc,
    toggle,
  } = useSortableColumns(baseRows, {
    columns: COLUMNS,
    initial: { key: "default", asc: true },
    tieBreaker: (r) => r.name,
  });

  return (
    <WidgetShell
      title="This week's M+ runs"
      description="Every Mythic+ run each member has completed this reset, highest key first."
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
          <caption className="sr-only">
            This week&apos;s completed M+ runs per character
          </caption>
          <thead>
            <tr className="border-border text-muted-foreground border-b text-xs uppercase">
              <SortableHeader label="Character" col="name" active={sortKey === "name"} asc={asc} onSort={toggle} />
              <SortableHeader label="Runs this week" col="runs" active={sortKey === "runs"} asc={asc} onSort={toggle} align="right" className="pr-0 pl-3" />
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {rows.map((row) => (
              <tr key={row.id}>
                <th
                  scope="row"
                  className="max-w-[10rem] truncate py-1.5 pr-3 text-left align-top font-medium"
                >
                  {row.name}
                </th>
                <td className="py-1.5 pl-3 text-right tabular-nums">
                  {row.runs.length > 0 ? (
                    <span className="inline-flex flex-wrap justify-end gap-1">
                      {row.runs.map((run, i) => (
                        <span
                          key={i}
                          className="bg-muted inline-flex items-baseline gap-1 rounded px-1.5 py-0.5"
                        >
                          {run.mapName && (
                            <span className="font-medium">{run.mapName}</span>
                          )}
                          <span className="text-primary font-mono">
                            +{run.level ?? "?"}
                          </span>
                        </span>
                      ))}
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
