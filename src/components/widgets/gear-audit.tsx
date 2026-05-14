"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

export function GearAuditWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Gear audit"
      description="Members with missing enchants or empty gem sockets."
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        (() => {
          const flagged = q.data.members.filter(
            (m) =>
              (m.latest.equipment?.missingEnchantsCount ?? 0) > 0 ||
              (m.latest.equipment?.missingGemsCount ?? 0) > 0,
          );
          if (flagged.length === 0) {
            return (
              <p className="text-sm text-green-500">
                Everyone is fully enchanted and gemmed. ✓
              </p>
            );
          }
          return (
            <ul className="divide-border divide-y text-sm">
              {flagged.map((m) => (
                <li
                  key={m.character.id}
                  className="flex items-baseline justify-between py-1.5"
                >
                  <span>
                    <span className="font-medium">{m.character.name}</span>
                    <span className="text-muted-foreground ml-2 text-xs">
                      {m.character.realmSlug}
                    </span>
                  </span>
                  <span className="text-destructive font-mono text-xs">
                    {(m.latest.equipment?.missingEnchantsCount ?? 0) > 0 && (
                      <span>
                        {m.latest.equipment?.missingEnchantsCount} enchant
                        {m.latest.equipment?.missingEnchantsCount === 1 ? "" : "s"}
                      </span>
                    )}
                    {(m.latest.equipment?.missingEnchantsCount ?? 0) > 0 &&
                      (m.latest.equipment?.missingGemsCount ?? 0) > 0 && (
                        <span className="text-muted-foreground"> · </span>
                      )}
                    {(m.latest.equipment?.missingGemsCount ?? 0) > 0 && (
                      <span>
                        {m.latest.equipment?.missingGemsCount} gem
                        {m.latest.equipment?.missingGemsCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          );
        })()
      )}
    </WidgetShell>
  );
}
