"use client";

import { api, type RouterOutputs } from "@/lib/trpc-client";
import { wowClassColor, wowClassName } from "@/lib/wow";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";
import {
  SortableHeader,
  useSortableColumns,
  type ColumnMap,
} from "./sortable-table";

type SortKey = "name" | "class" | "spec";

type LoadoutRow =
  RouterOutputs["snapshot"]["latestForTeam"]["members"][number] & {
    spec: string | null;
  };

const COLUMNS: ColumnMap<LoadoutRow, SortKey> = {
  name: { key: "name", accessor: (r) => r.character.name, kind: "text" },
  class: {
    key: "class",
    accessor: (r) => wowClassName(r.character.classId),
    kind: "text",
  },
  spec: { key: "spec", accessor: (r) => r.spec ?? "", kind: "text" },
};

/**
 * Each character's current spec + a copyable talent code (Blizzard's compressed
 * loadout string). Raid leaders use these to detect off-meta builds and to
 * import the team's actual loadouts into sim tools.
 */
export function TalentLoadoutsWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  const baseRows: LoadoutRow[] = (q.data?.members ?? []).map((m) => ({
    ...m,
    spec: m.latest.character?.specName ?? null,
  }));

  // Default: alphabetical by spec.
  const {
    sorted: rows,
    sortKey,
    asc,
    toggle,
  } = useSortableColumns(baseRows, {
    columns: COLUMNS,
    initial: { key: "spec", asc: true },
    tieBreaker: (r) => r.character.name,
  });

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

  return (
    <WidgetShell
      title="Talent loadouts"
      description="Current spec per character (from the latest Tier A summary)."
    >
      <table className="w-full text-sm">
        <caption className="sr-only">Talent loadouts</caption>
        <thead>
          <tr className="text-muted-foreground text-left text-xs uppercase">
            <SortableHeader label="Character" col="name" active={sortKey === "name"} asc={asc} onSort={toggle} />
            <SortableHeader label="Class" col="class" active={sortKey === "class"} asc={asc} onSort={toggle} />
            <SortableHeader label="Spec" col="spec" active={sortKey === "spec"} asc={asc} onSort={toggle} />
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
