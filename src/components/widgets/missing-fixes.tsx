"use client";

import { api } from "@/lib/trpc-client";
import { wowClassColor, wowClassName } from "@/lib/wow";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Flat list of every character with at least one missing enchant or gem,
 * sorted by ilvl descending so officers know who is high-ilvl-but-sloppy.
 * Unlike `gear_audit` which summarises counts, this widget surfaces an
 * action-list intended for raid-night enforcement.
 */
export function MissingFixesWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  if (q.isPending) {
    return (
      <WidgetShell title="Missing enchants / gems">
        <WidgetLoading />
      </WidgetShell>
    );
  }
  if (q.error) {
    return (
      <WidgetShell title="Missing enchants / gems">
        <WidgetError message={q.error.message} />
      </WidgetShell>
    );
  }

  const offenders = q.data.members
    .map((m) => {
      const ench = m.latest.equipment?.missingEnchantsCount ?? 0;
      const gem = m.latest.equipment?.missingGemsCount ?? 0;
      const ilvl =
        m.latest.equipment?.itemLevel ?? m.latest.character?.itemLevel ?? 0;
      return { ...m, missingEnchants: ench, missingGems: gem, ilvl };
    })
    .filter((m) => m.missingEnchants + m.missingGems > 0)
    .sort((a, b) => b.ilvl - a.ilvl);

  return (
    <WidgetShell
      title="Missing enchants / gems"
      description="Action list — sorted by item level so high-geared offenders surface first."
    >
      {offenders.length === 0 ? (
        <WidgetEmpty>Every tracked character is fully enchanted and gemmed. ✨</WidgetEmpty>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Missing enchants and gems</caption>
          <thead>
            <tr className="text-muted-foreground text-left text-xs uppercase">
              <th scope="col" className="py-1 pr-3 font-medium">Character</th>
              <th scope="col" className="py-1 pr-3 font-medium">Class</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">iLvL</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Ench</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Gems</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {offenders.map((m) => (
              <tr key={m.character.id}>
                <td className="py-1.5 pr-3 font-medium">{m.character.name}</td>
                <td className="py-1.5 pr-3">
                  <span
                    style={{ color: wowClassColor(m.character.classId) }}
                  >
                    {wowClassName(m.character.classId)}
                  </span>
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {m.ilvl || "—"}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {m.missingEnchants > 0 ? (
                    <span className="text-amber-500">{m.missingEnchants}</span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {m.missingGems > 0 ? (
                    <span className="text-amber-500">{m.missingGems}</span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </WidgetShell>
  );
}
