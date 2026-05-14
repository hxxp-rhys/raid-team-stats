"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

type VaultSlots = {
  raid?: { unlocked?: number; total?: number };
  mythicPlus?: { unlocked?: number; total?: number };
  world?: { unlocked?: number; total?: number };
} | null | undefined;

/**
 * Three rows per character — raid / M+ / world vault categories.
 * Unlocked rendered as a small filled-pip series; empty as outlined pips.
 */
function Pips({ unlocked, total }: { unlocked: number; total: number }) {
  if (total <= 0) return <span className="text-muted-foreground text-xs">—</span>;
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={
            i < unlocked
              ? "bg-primary inline-block size-2 rounded-full"
              : "border-muted-foreground/40 inline-block size-2 rounded-full border"
          }
        />
      ))}
    </span>
  );
}

export function VaultProgressWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Great Vault progress"
      description="Slots unlocked this reset (raid / M+ / world)."
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Vault progress</caption>
          <thead>
            <tr className="text-muted-foreground text-left text-xs uppercase">
              <th scope="col" className="py-1 pr-3 font-medium">
                Character
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Raid
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                M+
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                World
              </th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {q.data.members.map((m) => {
              const slots = (m.latest.vault?.slots ?? null) as VaultSlots;
              const raid = slots?.raid ?? { unlocked: 0, total: 0 };
              const mp = slots?.mythicPlus ?? { unlocked: 0, total: 0 };
              const wo = slots?.world ?? { unlocked: 0, total: 0 };
              return (
                <tr key={m.character.id}>
                  <td className="py-1.5 pr-3 font-medium">{m.character.name}</td>
                  <td className="py-1.5 pr-3">
                    <Pips unlocked={raid.unlocked ?? 0} total={raid.total ?? 3} />
                  </td>
                  <td className="py-1.5 pr-3">
                    <Pips unlocked={mp.unlocked ?? 0} total={mp.total ?? 3} />
                  </td>
                  <td className="py-1.5 pr-3">
                    <Pips unlocked={wo.unlocked ?? 0} total={wo.total ?? 3} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </WidgetShell>
  );
}
