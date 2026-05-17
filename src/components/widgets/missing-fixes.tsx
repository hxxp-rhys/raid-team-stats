"use client";

import { api } from "@/lib/trpc-client";
import { wowClassColor, wowClassName } from "@/lib/wow";
import { WidgetShell, WidgetLoading, WidgetError, WidgetEmpty } from "./shell";

/**
 * Per-character enchant/gem readiness. Each character gets two gear icons:
 * red when something is missing (with the count), green when fully done.
 * Hovering an icon names the exact slots (e.g. "Head, Shoulder"). Slot
 * logic is Midnight-correct and computed server-side. Sorted worst-first.
 */

// "Head, Shoulder" / "Ring 1, Neck ×2" — dedupe repeats (e.g. two empty
// sockets on one item) into a "×N" suffix, preserving first-seen order.
function formatSlots(slots: string[]): string {
  const counts = new Map<string, number>();
  for (const s of slots) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()]
    .map(([s, n]) => (n > 1 ? `${s} ×${n}` : s))
    .join(", ");
}

function GearIcon({ ok, title }: { ok: boolean; title: string }) {
  return (
    <span
      title={title}
      className={ok ? "text-green-500" : "text-destructive"}
      aria-label={title}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
        className="inline-block"
      >
        <path
          fill="currentColor"
          d="M19.14 12.94a7.9 7.9 0 0 0 .05-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.43h-3.84a.5.5 0 0 0-.5.43l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.9 7.9 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54a.5.5 0 0 0 .5.43h3.84a.5.5 0 0 0 .5-.43l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.21.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2Z"
        />
      </svg>
    </span>
  );
}

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
  if (q.data.members.length === 0) {
    return (
      <WidgetShell title="Missing enchants / gems">
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      </WidgetShell>
    );
  }

  const rows = q.data.members
    .map((m) => {
      const ench = m.latest.equipment?.missingEnchantsCount ?? 0;
      const gem = m.latest.equipment?.missingGemsCount ?? 0;
      const enchSlots = m.latest.equipment?.missingEnchantSlots ?? [];
      const gemSlots = m.latest.equipment?.missingGemSlots ?? [];
      const ilvl =
        m.latest.equipment?.itemLevel ?? m.latest.character?.itemLevel ?? 0;
      const hasEquip = !!m.latest.equipment;
      return {
        ...m,
        missingEnchants: ench,
        missingGems: gem,
        enchSlots,
        gemSlots,
        ilvl,
        hasEquip,
      };
    })
    // Worst (most missing) first, then by ilvl desc.
    .sort(
      (a, b) =>
        b.missingEnchants + b.missingGems - (a.missingEnchants + a.missingGems) ||
        b.ilvl - a.ilvl,
    );

  return (
    <WidgetShell
      title="Missing enchants / gems"
      description="Green gear = ready · red gear = needs fixing. Hover an icon to see which slots (WoW Midnight enchant rules)."
    >
      <table className="w-full text-sm">
        <caption className="sr-only">Enchant and gem readiness</caption>
        <thead>
          <tr className="text-muted-foreground text-left text-xs uppercase">
            <th scope="col" className="py-1 pr-3 font-medium">Character</th>
            <th scope="col" className="py-1 pr-3 font-medium">Class</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">iLvL</th>
            <th scope="col" className="py-1 pr-3 text-center font-medium">Enchants</th>
            <th scope="col" className="py-1 pr-3 text-center font-medium">Gems</th>
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
              <td className="py-1.5 pr-3 text-right tabular-nums">
                {m.ilvl || "—"}
              </td>
              <td className="py-1.5 pr-3 text-center">
                {!m.hasEquip ? (
                  <span className="text-muted-foreground text-xs">—</span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <GearIcon
                      ok={m.missingEnchants === 0}
                      title={
                        m.missingEnchants === 0
                          ? "All enchants applied"
                          : `Missing enchant${m.missingEnchants === 1 ? "" : "s"}: ${formatSlots(m.enchSlots)}`
                      }
                    />
                    {m.missingEnchants > 0 && (
                      <span className="text-destructive text-xs tabular-nums">
                        {m.missingEnchants}
                      </span>
                    )}
                  </span>
                )}
              </td>
              <td className="py-1.5 pr-3 text-center">
                {!m.hasEquip ? (
                  <span className="text-muted-foreground text-xs">—</span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <GearIcon
                      ok={m.missingGems === 0}
                      title={
                        m.missingGems === 0
                          ? "All sockets gemmed"
                          : `Empty socket${m.missingGems === 1 ? "" : "s"}: ${formatSlots(m.gemSlots)}`
                      }
                    />
                    {m.missingGems > 0 && (
                      <span className="text-destructive text-xs tabular-nums">
                        {m.missingGems}
                      </span>
                    )}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </WidgetShell>
  );
}
