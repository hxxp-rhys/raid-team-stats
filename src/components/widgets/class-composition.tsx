"use client";

import { api } from "@/lib/trpc-client";
import { inferRole, wowClassColor, wowClassName } from "@/lib/wow";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

export function ClassCompositionWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

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
  const byRole: Record<"TANK" | "HEAL" | "DPS" | "UNKNOWN", number> = {
    TANK: 0,
    HEAL: 0,
    DPS: 0,
    UNKNOWN: 0,
  };
  for (const m of q.data.members) {
    const cid = m.character.classId ?? 0;
    if (cid > 0) byClass.set(cid, (byClass.get(cid) ?? 0) + 1);
    const role = inferRole(cid, m.latest.character?.specName);
    if (role) byRole[role]++;
    else byRole.UNKNOWN++;
  }

  const sortedClasses = [...byClass.entries()].sort((a, b) => b[1] - a[1]);
  const total = q.data.members.length;

  return (
    <WidgetShell
      title="Class composition"
      description={`${total} member${total === 1 ? "" : "s"} · roles inferred from latest spec`}
    >
      <div className="space-y-4">
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
      </div>
    </WidgetShell>
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
