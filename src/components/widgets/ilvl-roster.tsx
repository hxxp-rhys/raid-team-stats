"use client";

import { useMemo, useState } from "react";

import { api } from "@/lib/trpc-client";
import { wowClassColor } from "@/lib/wow";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Team Roster — every active member with their roster RANK, realm, level and
 * equipped iLvL. Sortable by any column (default: alphabetical by character).
 * Rank sorts by standing (Raid Leader → Officer → Main → Trial → Flex →
 * Rotational → Social → unranked), not alphabetically.
 */

const RANK_LABEL: Record<string, string> = {
  RAID_LEADER: "Raid Leader",
  OFFICER: "Officer",
  MAIN: "Main",
  TRIAL: "Trial",
  FLEX: "Flex",
  ROTATIONAL: "Rotational",
  SOCIAL: "Social",
};
// Standing order for rank sorting (lower = higher standing). Unranked last.
const RANK_ORDER: Record<string, number> = {
  RAID_LEADER: 0,
  OFFICER: 1,
  MAIN: 2,
  TRIAL: 3,
  FLEX: 4,
  ROTATIONAL: 5,
  SOCIAL: 6,
};
const rankOrder = (r: string | null | undefined) =>
  r != null && r in RANK_ORDER ? RANK_ORDER[r]! : 99;

type SortKey = "name" | "rank" | "realm" | "level" | "ilvl";

export function IlvlRosterWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });
  // Default: alphabetical by character name.
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [asc, setAsc] = useState(true);

  const rows = useMemo(() => {
    const members = q.data?.members ?? [];
    const withVals = members.map((m) => ({
      m,
      name: m.character.name,
      rank: (m as { rank?: string | null }).rank ?? null,
      realm: m.character.realmSlug,
      level: m.character.level ?? 0,
      ilvl:
        m.latest.equipment?.itemLevel ?? m.latest.character?.itemLevel ?? null,
    }));
    const dir = asc ? 1 : -1;
    const cmp = (a: (typeof withVals)[number], b: (typeof withVals)[number]) => {
      switch (sortKey) {
        case "rank": {
          const d = rankOrder(a.rank) - rankOrder(b.rank);
          return d !== 0 ? d * dir : a.name.localeCompare(b.name);
        }
        case "realm": {
          const d = a.realm.localeCompare(b.realm);
          return d !== 0 ? d * dir : a.name.localeCompare(b.name);
        }
        case "level":
          return (a.level - b.level) * dir || a.name.localeCompare(b.name);
        case "ilvl":
          return ((a.ilvl ?? -1) - (b.ilvl ?? -1)) * dir || a.name.localeCompare(b.name);
        case "name":
        default:
          return a.name.localeCompare(b.name) * dir;
      }
    };
    return [...withVals].sort(cmp);
  }, [q.data, sortKey, asc]);

  const toggle = (key: SortKey) => {
    if (key === sortKey) {
      setAsc((v) => !v);
    } else {
      setSortKey(key);
      // Sensible default direction per column: text asc, numbers desc.
      setAsc(key === "name" || key === "realm" || key === "rank");
    }
  };

  return (
    <WidgetShell
      title="Team Roster"
      description="Active members with roster rank, realm, level and equipped iLvL."
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : rows.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Team roster</caption>
            <thead>
              <tr className="text-muted-foreground text-left text-xs uppercase">
                <SortHeader label="Character" col="name" sortKey={sortKey} asc={asc} onClick={toggle} />
                <SortHeader label="Rank" col="rank" sortKey={sortKey} asc={asc} onClick={toggle} />
                <SortHeader label="Realm" col="realm" sortKey={sortKey} asc={asc} onClick={toggle} />
                <SortHeader label="Lvl" col="level" sortKey={sortKey} asc={asc} onClick={toggle} />
                <SortHeader label="iLvL" col="ilvl" sortKey={sortKey} asc={asc} onClick={toggle} align="right" />
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {rows.map(({ m, rank, ilvl }) => (
                <tr key={m.character.id}>
                  <td
                    className="py-1.5 pr-3 font-medium"
                    style={{ color: wowClassColor(m.character.classId) }}
                  >
                    {m.character.name}
                  </td>
                  <td className="py-1.5 pr-3">
                    {rank ? (
                      RANK_LABEL[rank] ?? rank
                    ) : (
                      <span className="text-muted-foreground/60">—</span>
                    )}
                  </td>
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </WidgetShell>
  );
}

function SortHeader({
  label,
  col,
  sortKey,
  asc,
  onClick,
  align,
}: {
  label: string;
  col: SortKey;
  sortKey: SortKey;
  asc: boolean;
  onClick: (c: SortKey) => void;
  align?: "right";
}) {
  const active = sortKey === col;
  return (
    <th
      scope="col"
      aria-sort={active ? (asc ? "ascending" : "descending") : "none"}
      className={`py-1 pr-3 font-medium ${align === "right" ? "text-right" : ""}`}
    >
      <button
        type="button"
        onClick={() => onClick(col)}
        className={`inline-flex items-center gap-0.5 uppercase hover:text-foreground ${
          active ? "text-foreground" : ""
        }`}
      >
        {label}
        <span className="text-[9px]">{active ? (asc ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}
