"use client";

import { api, type RouterOutputs } from "@/lib/trpc-client";
import { wowClassColor, wowClassName } from "@/lib/wow";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";
import {
  SortableHeader,
  useSortableColumns,
  type ColumnMap,
} from "./sortable-table";

type SortKey = "name" | "class" | "runs" | "highest";

type TeamMember =
  RouterOutputs["snapshot"]["latestForTeam"]["members"][number];

/**
 * "Did everyone run M+ this week?" view. Shows weekly run count and the
 * highest key timed. Vault-slot progress lives on the Great Vault widget.
 */
type MemberRow = TeamMember & { runsCount: number; highest: number | null };

const COLUMNS: ColumnMap<MemberRow, SortKey> = {
  name: { key: "name", accessor: (r) => r.character.name, kind: "text" },
  class: {
    key: "class",
    accessor: (r) => wowClassName(r.character.classId),
    kind: "text",
  },
  runs: { key: "runs", accessor: (r) => r.runsCount, kind: "number" },
  highest: { key: "highest", accessor: (r) => r.highest, kind: "number" },
};

export function MplusWeeklyWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  const baseRows: MemberRow[] = (q.data?.members ?? []).map((m) => {
    // Exact weekly completions (repeats included) when available; fall
    // back to the per-dungeon best-runs array length for old snapshots.
    const runsRaw = m.latest.mplus?.runsThisWeek;
    const fallback = Array.isArray(runsRaw)
      ? runsRaw.length
      : typeof runsRaw === "number"
        ? runsRaw
        : 0;
    const runsCount = m.latest.mplus?.weeklyRunCount ?? fallback;
    const highest =
      typeof m.latest.mplus?.weeklyHighest === "number"
        ? m.latest.mplus.weeklyHighest
        : null;
    return { ...m, runsCount, highest };
  });

  // Default: most runs first.
  const {
    sorted: rows,
    sortKey,
    asc,
    toggle,
  } = useSortableColumns(baseRows, {
    columns: COLUMNS,
    initial: { key: "runs", asc: false },
    tieBreaker: (r) => r.character.name,
  });

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

  return (
    <WidgetShell
      title="M+ this week"
      description="Weekly M+ run count and the highest key timed. Vault-slot progress is on the Great Vault widget."
    >
      <table className="w-full text-sm">
        <caption className="sr-only">M+ progress this week</caption>
        <thead>
          <tr className="text-muted-foreground text-left text-xs uppercase">
            <SortableHeader label="Character" col="name" active={sortKey === "name"} asc={asc} onSort={toggle} />
            <SortableHeader label="Class" col="class" active={sortKey === "class"} asc={asc} onSort={toggle} />
            <SortableHeader label="Runs" col="runs" active={sortKey === "runs"} asc={asc} onSort={toggle} align="right" />
            <SortableHeader label="Highest" col="highest" active={sortKey === "highest"} asc={asc} onSort={toggle} align="right" />
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
            </tr>
          ))}
        </tbody>
      </table>
    </WidgetShell>
  );
}
