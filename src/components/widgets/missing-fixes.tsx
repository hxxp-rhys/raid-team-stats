"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { Modal } from "@/components/ui/modal";
import { wowClassColor, wowClassName } from "@/lib/wow";
import { WidgetShell, WidgetLoading, WidgetError, WidgetEmpty } from "./shell";
import {
  formatSlots,
  selectMissing,
  sortByWorst,
} from "@/lib/widgets/missing-fixes-logic";

/**
 * Per-character enchant/gem readiness. Each character gets two gear icons:
 * red when something is missing (with the count), green when fully done.
 * Hovering an icon names the exact slots (e.g. "Head, Shoulder"). Slot
 * logic is Midnight-correct and computed server-side. Sorted worst-first.
 * A "View list" header button opens a lightbox of only the characters still
 * needing fixing, with their exact slots. (Pure data-shaping is unit-tested in
 * src/lib/widgets/missing-fixes-logic.ts.)
 */

function CogSvg() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="inline-block shrink-0"
    >
      <path
        fill="currentColor"
        d="M19.14 12.94a7.9 7.9 0 0 0 .05-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.43h-3.84a.5.5 0 0 0-.5.43l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.9 7.9 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54a.5.5 0 0 0 .5.43h3.84a.5.5 0 0 0 .5-.43l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.21.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2Z"
      />
    </svg>
  );
}

/**
 * One enchant/gem status cell. Cog is green when nothing's missing, red
 * with the count otherwise. The missing-slot list is shown ONLY in the
 * hover tooltip (native `title`, also exposed via `aria-label` for screen
 * readers) — never rendered inline in the widget body.
 */
function StatusCell({
  ok,
  count,
  slots,
  okText,
  missLabel,
}: {
  ok: boolean;
  count: number;
  slots: string[];
  okText: string;
  missLabel: string;
}) {
  const detail = ok ? okText : `${missLabel}: ${formatSlots(slots)}`;
  return (
    <span
      title={detail}
      aria-label={detail}
      className="inline-flex items-center gap-1"
    >
      <span className={ok ? "text-green-500" : "text-destructive"}>
        <CogSvg />
      </span>
      {!ok && (
        <span className="text-destructive text-xs tabular-nums">{count}</span>
      )}
    </span>
  );
}

export function MissingFixesWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });
  const [listOpen, setListOpen] = useState(false);

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
    .sort(sortByWorst);

  // Only the characters with at least one unfixed slot — the lightbox subject.
  const missing = selectMissing(rows);

  return (
    <WidgetShell
      title="Missing enchants / gems"
      description="Green gear = ready · red gear = needs fixing. Hover an icon to see which slots (WoW Midnight enchant rules)."
      headerAction={
        <button
          type="button"
          onClick={() => setListOpen(true)}
          className="border-border hover:bg-muted text-foreground inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors"
          title="Open a list of only the characters missing enchants or gems"
        >
          View list
          <span
            className={
              "tabular-nums " +
              (missing.length > 0 ? "text-destructive" : "text-green-500")
            }
          >
            ({missing.length})
          </span>
        </button>
      }
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
                  <StatusCell
                    ok={m.missingEnchants === 0}
                    count={m.missingEnchants}
                    slots={m.enchSlots}
                    okText="All enchants applied"
                    missLabel={`Missing enchant${m.missingEnchants === 1 ? "" : "s"}`}
                  />
                )}
              </td>
              <td className="py-1.5 pr-3 text-center">
                {!m.hasEquip ? (
                  <span className="text-muted-foreground text-xs">—</span>
                ) : (
                  <StatusCell
                    ok={m.missingGems === 0}
                    count={m.missingGems}
                    slots={m.gemSlots}
                    okText="All sockets gemmed"
                    missLabel={`Empty socket${m.missingGems === 1 ? "" : "s"}`}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Modal
        open={listOpen}
        onClose={() => setListOpen(false)}
        title="Missing enchants / gems"
        description={
          missing.length > 0
            ? `${missing.length} character${missing.length === 1 ? "" : "s"} need fixing — newest gear first.`
            : undefined
        }
      >
        {missing.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Everyone’s fully enchanted and gemmed. ✅
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {missing.map((m) => (
              <li key={m.character.id} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className="font-medium"
                    style={{ color: wowClassColor(m.character.classId) }}
                  >
                    {m.character.name}
                    <span className="text-muted-foreground ml-2 text-xs font-normal">
                      {wowClassName(m.character.classId)}
                    </span>
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    iLvL {m.ilvl || "—"}
                  </span>
                </div>
                <div className="mt-1 space-y-0.5 text-sm">
                  {m.missingEnchants > 0 && (
                    <p>
                      <span className="text-destructive font-medium">
                        Missing enchant{m.missingEnchants === 1 ? "" : "s"} ({m.missingEnchants}):
                      </span>{" "}
                      <span className="text-muted-foreground">
                        {formatSlots(m.enchSlots)}
                      </span>
                    </p>
                  )}
                  {m.missingGems > 0 && (
                    <p>
                      <span className="text-destructive font-medium">
                        Empty socket{m.missingGems === 1 ? "" : "s"} ({m.missingGems}):
                      </span>{" "}
                      <span className="text-muted-foreground">
                        {formatSlots(m.gemSlots)}
                      </span>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </WidgetShell>
  );
}
