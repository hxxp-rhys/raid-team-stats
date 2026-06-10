"use client";

import { useMemo, useState } from "react";

import { api } from "@/lib/trpc-client";
import { inferRole, wowClassColor, wowClassName } from "@/lib/wow";
import { Modal } from "@/components/ui/modal";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

type Role = "TANK" | "HEAL" | "DPS" | "UNKNOWN";

const ROLE_LABEL: Record<Role, string> = {
  TANK: "Tank",
  HEAL: "Healer",
  DPS: "DPS",
  UNKNOWN: "—",
};

type MemberRow = {
  characterId: string;
  name: string;
  realmSlug: string;
  level: number | null;
  classId: number;
  specName: string | null;
  role: Role;
};

export function ClassCompositionWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });
  const [detailOpen, setDetailOpen] = useState(false);

  // Always derive the per-character rows so the Modal can render them
  // without re-traversing the snapshot. `useMemo` keys on the query data
  // identity so re-renders during polling don't churn the work.
  const rows = useMemo<MemberRow[]>(() => {
    if (!q.data) return [];
    return q.data.members.map((m) => {
      const classId = m.character.classId ?? 0;
      const specName = m.latest.character?.specName ?? null;
      const role: Role = inferRole(classId, specName) ?? "UNKNOWN";
      return {
        characterId: m.character.id,
        name: m.character.name,
        realmSlug: m.character.realmSlug,
        level: m.character.level,
        classId,
        specName,
        role,
      };
    });
  }, [q.data]);

  if (q.isPending) {
    return (
      <WidgetShell title="Class composition">
        <WidgetLoading />
      </WidgetShell>
    );
  }
  if (q.error) {
    return (
      <WidgetShell title="Class composition">
        <WidgetError message={q.error.message} />
      </WidgetShell>
    );
  }
  if (q.data.members.length === 0) {
    return (
      <WidgetShell title="Class composition">
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      </WidgetShell>
    );
  }

  const byClass = new Map<number, number>();
  const byRole: Record<Role, number> = { TANK: 0, HEAL: 0, DPS: 0, UNKNOWN: 0 };
  for (const r of rows) {
    if (r.classId > 0) byClass.set(r.classId, (byClass.get(r.classId) ?? 0) + 1);
    byRole[r.role]++;
  }

  const sortedClasses = [...byClass.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.length;

  return (
    <>
      <WidgetShell
        title="Class composition"
        description={`${total} member${total === 1 ? "" : "s"} · roles inferred from latest spec`}
      >
        <div className="flex h-full flex-col gap-4">
          <div className="grid grid-cols-3 gap-2 text-sm">
            <RoleCell label="Tanks" count={byRole.TANK} />
            <RoleCell label="Healers" count={byRole.HEAL} />
            <RoleCell label="DPS" count={byRole.DPS} />
          </div>

          <ul className="space-y-1.5">
            {sortedClasses.map(([classId, count]) => {
              const pct = (count / total) * 100;
              return (
                <li key={classId} className="flex items-center gap-2 text-sm">
                  <span className="min-w-32 font-medium">
                    {wowClassName(classId)}
                  </span>
                  <div className="bg-muted relative h-2 flex-1 overflow-hidden rounded-full">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: wowClassColor(classId),
                      }}
                    />
                  </div>
                  <span className="text-muted-foreground tabular-nums min-w-8 text-right">
                    {count}
                  </span>
                </li>
              );
            })}
          </ul>

          {/* "Expand" affordance — click reveals the full per-character
              roster grouped by class. Pushed to the bottom of the widget
              so it sits below the chart at any widget height. */}
          <div className="mt-auto pt-1">
            <button
              type="button"
              onClick={() => setDetailOpen(true)}
              className="text-primary text-xs underline-offset-4 hover:underline"
              aria-label="Show roster grouped by class"
            >
              Show roster ({total}) →
            </button>
          </div>
        </div>
      </WidgetShell>

      <Modal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title="Class composition · roster"
        description={`${total} member${total === 1 ? "" : "s"}, grouped by class.`}
      >
        <RosterDetail rows={rows} sortedClassIds={sortedClasses.map(([id]) => id)} />
      </Modal>
    </>
  );
}

function RoleCell({ label, count }: { label: string; count: number }) {
  return (
    <div className="rounded-md border border-border p-2">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{count}</p>
    </div>
  );
}

function RosterDetail({
  rows,
  sortedClassIds,
}: {
  rows: MemberRow[];
  sortedClassIds: number[];
}) {
  // Group rows by classId so each class becomes its own section. Within a
  // class, characters sort alphabetically (locale-aware, case-insensitive)
  // with realm as tie-break for same-name alts.
  const grouped = useMemo(() => {
    const map = new Map<number, MemberRow[]>();
    for (const r of rows) {
      const arr = map.get(r.classId) ?? [];
      arr.push(r);
      map.set(r.classId, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        const byName = a.name.localeCompare(b.name, undefined, {
          sensitivity: "base",
        });
        if (byName !== 0) return byName;
        return a.realmSlug.localeCompare(b.realmSlug);
      });
    }
    return map;
  }, [rows]);

  return (
    <div className="space-y-5 text-sm">
      {sortedClassIds.map((classId) => {
        const members = grouped.get(classId) ?? [];
        if (members.length === 0) return null;
        return (
          <section key={classId}>
            <header className="flex items-center gap-2 pb-1.5">
              <span
                aria-hidden
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: wowClassColor(classId) }}
              />
              <h3 className="font-semibold">
                {wowClassName(classId)}
                <span className="text-muted-foreground ml-1.5 text-xs font-normal tabular-nums">
                  · {members.length}
                </span>
              </h3>
            </header>
            <ul className="divide-border border-border divide-y rounded-md border">
              {members.map((m) => (
                <li
                  key={m.characterId}
                  className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-3 py-2"
                >
                  <span className="font-medium">{m.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {m.realmSlug}
                  </span>
                  <span className="text-muted-foreground tabular-nums text-xs">
                    lvl {m.level ?? "—"}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {m.specName ? `${m.specName} · ` : ""}
                    {ROLE_LABEL[m.role]}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
