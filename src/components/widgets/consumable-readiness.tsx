"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Raid-prep checklist — flasks/phials, potions, food and weapon
 * enhancements each member is carrying. Bag contents have no web API;
 * this is addon-only. Green = stocked, red = none.
 */
const COLS = [
  { key: "flask", label: "Flask" },
  { key: "potion", label: "Pots" },
  { key: "food", label: "Food" },
  { key: "weaponEnh", label: "Wpn" },
] as const;

function Cell({
  n,
  items,
}: {
  n: number;
  items: Array<{ name: string; count: number }>;
}) {
  const tip =
    items.length > 0
      ? items.map((i) => `${i.name} ×${i.count}`).join("\n")
      : undefined;
  return (
    <td className="px-2 py-1.5 text-center tabular-nums">
      <span
        title={tip}
        className={
          n > 0
            ? "text-green-500 font-medium" + (tip ? " cursor-help" : "")
            : "text-destructive"
        }
      >
        {n > 0 ? n : "✗"}
      </span>
    </td>
  );
}

export function ConsumableReadinessWidget({
  raidTeamId,
}: {
  raidTeamId: string;
}) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Raid consumables"
      description="Flasks / potions / food / weapon enhancements on hand. Needs the in-game uploader."
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
            Consumables carried per character
          </caption>
          <thead>
            <tr className="border-border text-muted-foreground border-b text-xs uppercase">
              <th scope="col" className="py-1 pr-3 text-left font-medium">
                Character
              </th>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className="px-2 py-1 text-center font-medium"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {q.data.members.map((m) => {
              const c = m.latest.addon?.consumables ?? null;
              return (
                <tr key={m.character.id}>
                  <th
                    scope="row"
                    className="max-w-[10rem] truncate py-1.5 pr-3 text-left font-medium"
                  >
                    {m.character.name}
                  </th>
                  {c ? (
                    COLS.map((col) => (
                      <Cell
                        key={col.key}
                        n={c[col.key]}
                        items={c.breakdown?.[col.key] ?? []}
                      />
                    ))
                  ) : (
                    <td
                      colSpan={COLS.length}
                      className="text-muted-foreground px-2 py-1.5 text-center"
                    >
                      no uploader data
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </WidgetShell>
  );
}
