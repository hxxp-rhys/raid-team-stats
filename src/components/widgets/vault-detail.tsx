"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Great Vault detail — all three rows (Raid / M+ / World·Delve) with
 * unlocked slots and progress toward each threshold. Addon-only data
 * (no Blizzard web API exposes the vault, especially the World row).
 */
const KINDS = [
  { key: "raid", label: "Raid" },
  { key: "mplus", label: "M+" },
  { key: "world", label: "World" },
] as const;

export function VaultDetailWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Great Vault detail"
      description="Unlocked slots + progress per row."
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
            Great Vault unlocked slots per character and row
          </caption>
          <thead>
            <tr className="border-border text-muted-foreground border-b text-xs uppercase">
              <th scope="col" className="py-1 pr-3 text-left font-medium">
                Character
              </th>
              {KINDS.map((k) => (
                <th key={k.key} scope="col" className="px-2 py-1 text-center font-medium">
                  {k.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {q.data.members.map((m) => {
              const v = m.latest.addon?.vault ?? null;
              return (
                <tr key={m.character.id}>
                  <th
                    scope="row"
                    className="max-w-[10rem] truncate py-1.5 pr-3 text-left font-medium"
                  >
                    {m.character.name}
                  </th>
                  {KINDS.map((k) => {
                    const cat = v?.find((c) => c.kind === k.key);
                    if (!cat || cat.rows.length === 0) {
                      return (
                        <td
                          key={k.key}
                          className="text-muted-foreground px-2 py-1.5 text-center"
                        >
                          —
                        </td>
                      );
                    }
                    const unlocked = cat.rows.filter((r) => r.unlocked).length;
                    const total = cat.rows.length;
                    const tip = cat.rows
                      .map((r) => `${r.progress ?? 0}/${r.threshold ?? "?"}`)
                      .join("  ·  ");
                    return (
                      <td
                        key={k.key}
                        className="px-2 py-1.5 text-center tabular-nums"
                        title={tip}
                      >
                        <span
                          className={
                            unlocked >= total
                              ? "text-green-500 font-medium"
                              : unlocked > 0
                                ? "text-foreground"
                                : "text-muted-foreground"
                          }
                        >
                          {unlocked}/{total}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </WidgetShell>
  );
}
