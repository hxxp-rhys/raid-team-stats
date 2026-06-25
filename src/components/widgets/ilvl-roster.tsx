"use client";

import { useMemo } from "react";

import { api, type RouterOutputs } from "@/lib/trpc-client";
import { wowClassColor } from "@/lib/wow";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";
import {
  SortableHeader,
  useSortableColumns,
  type ColumnMap,
} from "./sortable-table";

type TeamMember =
  RouterOutputs["snapshot"]["latestForTeam"]["members"][number];

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

type RosterRow = {
  m: TeamMember;
  name: string;
  rank: string | null;
  realm: string;
  level: number;
  ilvl: number | null;
  companion: {
    state: "none" | "ok" | "warning";
    lastReceivedAt: Date | string | null;
    companionVersion?: string | null;
    addonVersion?: string | null;
    companionOutdated?: boolean;
    addonOutdated?: boolean;
  };
};

// Per-column descriptors. Rank sorts by standing order (lower = higher
// standing), so it defaults ascending (best-first) like the original.
const COLUMNS: ColumnMap<RosterRow, SortKey> = {
  name: { key: "name", accessor: (r) => r.name, kind: "text" },
  rank: {
    key: "rank",
    accessor: (r) => rankOrder(r.rank),
    kind: "number",
    defaultAsc: true,
  },
  realm: { key: "realm", accessor: (r) => r.realm, kind: "text" },
  level: { key: "level", accessor: (r) => r.level, kind: "number" },
  ilvl: { key: "ilvl", accessor: (r) => r.ilvl, kind: "number" },
};

export function IlvlRosterWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  const baseRows = useMemo<RosterRow[]>(() => {
    const members = q.data?.members ?? [];
    return members.map((m) => ({
      m,
      name: m.character.name,
      rank: (m as { rank?: string | null }).rank ?? null,
      realm: m.character.realmSlug,
      level: m.character.level ?? 0,
      ilvl:
        m.latest.equipment?.itemLevel ?? m.latest.character?.itemLevel ?? null,
      companion: (
        m as {
          companion?: {
            state: "none" | "ok" | "warning";
            lastReceivedAt: Date | string | null;
            companionVersion?: string | null;
            addonVersion?: string | null;
            companionOutdated?: boolean;
            addonOutdated?: boolean;
          };
        }
      ).companion ?? { state: "none" as const, lastReceivedAt: null },
    }));
  }, [q.data]);

  // Default: alphabetical by character name.
  const {
    sorted: rows,
    sortKey,
    asc,
    toggle,
  } = useSortableColumns(baseRows, {
    columns: COLUMNS,
    initial: { key: "name", asc: true },
    tieBreaker: (r) => r.name,
  });

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
                <SortableHeader label="Character" col="name" active={sortKey === "name"} asc={asc} onSort={toggle} />
                <SortableHeader label="Rank" col="rank" active={sortKey === "rank"} asc={asc} onSort={toggle} />
                <SortableHeader label="Realm" col="realm" active={sortKey === "realm"} asc={asc} onSort={toggle} />
                <SortableHeader label="Lvl" col="level" active={sortKey === "level"} asc={asc} onSort={toggle} />
                <SortableHeader label="iLvL" col="ilvl" active={sortKey === "ilvl"} asc={asc} onSort={toggle} align="right" />
                <th scope="col" className="py-1 pr-3 text-center font-medium uppercase">
                  App
                </th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {rows.map(({ m, rank, ilvl, companion }) => (
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
                  <td className="py-1.5 pr-3 text-center">
                    <CompanionCell companion={companion} />
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

/**
 * Companion-app install indicator for one roster row. Install state is per-User
 * (the desktop uploader), so every character of the same user shows the same
 * icon; lastReceivedAt is that character's own most-recent addon upload.
 *   none    → muted dash (not installed / no telemetry)
 *   ok      → green check (installed, data fresh within 7 days)
 *   warning → amber ⚠ (installed but no data in 7 days / ever)
 */
function CompanionCell({
  companion,
}: {
  companion: {
    state: "none" | "ok" | "warning";
    lastReceivedAt: Date | string | null;
    companionVersion?: string | null;
    addonVersion?: string | null;
    companionOutdated?: boolean;
    addonOutdated?: boolean;
  };
}) {
  if (companion.state === "none") {
    return (
      <span className="text-muted-foreground/60" title="Not installed">
        —
      </span>
    );
  }
  const received =
    companion.lastReceivedAt != null
      ? new Date(companion.lastReceivedAt)
      : null;
  // Append the installed companion + addon versions to the tooltip when known.
  const versionPart =
    companion.companionVersion || companion.addonVersion
      ? `Companion v${companion.companionVersion ?? "?"} · Addon v${companion.addonVersion ?? "?"}`
      : null;
  const dataPart =
    received != null
      ? `Last data received: ${received.toLocaleString()}`
      : "No data received yet";
  const title = versionPart ? `${dataPart}\n${versionPart}` : dataPart;
  // Theme-colored asterisk when either the companion or addon is behind latest.
  const outdated = companion.companionOutdated || companion.addonOutdated;
  const glyph = companion.state === "warning" ? "⚠" : "✓";
  const glyphColor =
    companion.state === "warning" ? "text-amber-500" : "text-emerald-500";
  return (
    <span title={title} aria-label={title}>
      <span className={glyphColor}>{glyph}</span>
      {outdated ? (
        <span className="text-primary" aria-label="Update available">
          *
        </span>
      ) : null}
    </span>
  );
}
