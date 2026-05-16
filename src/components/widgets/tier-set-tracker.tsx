"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Per-character tier-set tracker. Five fixed armor slots (head, shoulder,
 * chest, hands, legs). Each slot shows a small armor icon above a circle:
 * the circle is filled + coloured by the piece's gear track (same palette
 * as the Great Vault widget) when tier is equipped there, or an empty
 * outline when the slot still needs a tier piece.
 */

type Track = "veteran" | "champion" | "hero" | "myth";
type TierSlotRow = {
  slot: "HEAD" | "SHOULDER" | "CHEST" | "HANDS" | "LEGS";
  filled?: boolean;
  itemLevel?: number | null;
  track?: Track | null;
};

const TRACK_FILL: Record<Track, string> = {
  veteran: "bg-green-500",
  champion: "bg-blue-500",
  hero: "bg-purple-400",
  myth: "bg-orange-400",
};

const SLOT_ORDER: TierSlotRow["slot"][] = [
  "HEAD",
  "SHOULDER",
  "CHEST",
  "HANDS",
  "LEGS",
];
const SLOT_LABEL: Record<TierSlotRow["slot"], string> = {
  HEAD: "Head",
  SHOULDER: "Shoulder",
  CHEST: "Chest",
  HANDS: "Hands",
  LEGS: "Legs",
};

// Minimal armor-piece glyphs per slot.
function SlotIcon({ slot }: { slot: TierSlotRow["slot"] }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "currentColor",
    "aria-hidden": true,
  } as const;
  switch (slot) {
    case "HEAD":
      return (
        <svg {...common}>
          <path d="M12 2a7 7 0 0 0-7 7v5l2 3h10l2-3V9a7 7 0 0 0-7-7Zm-3 8a1.5 1.5 0 1 1 0 .01ZM15 10a1.5 1.5 0 1 1 0 .01Z" />
        </svg>
      );
    case "SHOULDER":
      return (
        <svg {...common}>
          <path d="M3 13a6 6 0 0 1 6-6h6a6 6 0 0 1 6 6v5H3v-5Zm6-2a3 3 0 0 0-3 3v2h3v-5Zm9 0v5h3v-2a3 3 0 0 0-3-3Z" />
        </svg>
      );
    case "CHEST":
      return (
        <svg {...common}>
          <path d="M6 4h12l-1 4 1 12H6L7 8 6 4Zm5 5h2v8h-2V9Z" />
        </svg>
      );
    case "HANDS":
      return (
        <svg {...common}>
          <path d="M8 3v7m4-7v8m4-6v6M6 11h12v6a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4v-6Z" />
        </svg>
      );
    case "LEGS":
      return (
        <svg {...common}>
          <path d="M7 3h10l-1 7-2 11h-2l-1-9h-2l-1 9H6L4 10 7 3Z" />
        </svg>
      );
  }
}

export function TierSetTrackerWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Tier-set tracker"
      description="Tier pieces equipped per slot, coloured by gear track."
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        <ul className="divide-border divide-y text-sm">
          {q.data.members.map((m) => {
            const slots =
              (m.latest.equipment?.tierSlots as TierSlotRow[] | null) ?? null;
            const bySlot = new Map<string, TierSlotRow>();
            for (const s of slots ?? []) bySlot.set(s.slot, s);
            return (
              <li
                key={m.character.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span className="min-w-0 truncate font-medium">
                  {m.character.name}
                </span>
                <span className="flex shrink-0 items-end gap-3">
                  {SLOT_ORDER.map((slot) => {
                    const s = bySlot.get(slot);
                    const filled = !!s?.filled;
                    const track = s?.track ?? null;
                    const fill =
                      filled && track ? TRACK_FILL[track] : null;
                    return (
                      <span
                        key={slot}
                        className="flex flex-col items-center gap-1"
                        title={
                          filled
                            ? `${SLOT_LABEL[slot]} — ${track ?? "tier"}${
                                s?.itemLevel ? ` (ilvl ${s.itemLevel})` : ""
                              }`
                            : `${SLOT_LABEL[slot]} — no tier piece`
                        }
                      >
                        <span
                          className={
                            filled
                              ? "text-foreground"
                              : "text-muted-foreground/40"
                          }
                        >
                          <SlotIcon slot={slot} />
                        </span>
                        <span
                          className={
                            fill
                              ? `${fill} size-3 rounded-full`
                              : "border-muted-foreground/40 size-3 rounded-full border"
                          }
                        />
                      </span>
                    );
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetShell>
  );
}
