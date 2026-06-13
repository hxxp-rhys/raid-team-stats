"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AttendanceState } from "@/lib/calendar/roster";

/** Display metadata for each attendance state. */
export const STATE_META: Record<
  AttendanceState,
  { label: string; glyph: string; className: string; ring: string }
> = {
  CONFIRM: { label: "Confirm", glyph: "✅", className: "text-emerald-500", ring: "ring-emerald-500" },
  LATE: { label: "Late", glyph: "🕒", className: "text-sky-500", ring: "ring-sky-500" },
  TENTATIVE: { label: "Tentative", glyph: "🟡", className: "text-amber-500", ring: "ring-amber-500" },
  ABSENT: { label: "Absent", glyph: "❌", className: "text-destructive", ring: "ring-destructive" },
  NO_RESPONSE: { label: "No response", glyph: "⬜", className: "text-muted-foreground", ring: "ring-border" },
};

const PICKABLE: AttendanceState[] = ["CONFIRM", "TENTATIVE", "LATE", "ABSENT"];

function newActionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `a-${Date.now()}-${Math.random()}`;
}

/**
 * Segmented one-tap status control for the current user on an event.
 * Optimistic: the pressed state highlights immediately; the live-sync poll
 * reconciles. Late reveals an ETA stepper. `onChanged` lets the parent refetch.
 */
export function StatusControl({
  eventId,
  current,
  currentEta,
  disabled,
  size = "md",
  onChanged,
}: {
  eventId: string;
  current: AttendanceState | null;
  currentEta?: number | null;
  disabled?: boolean;
  size?: "sm" | "md";
  onChanged?: () => void;
}) {
  const utils = api.useUtils();
  // Optimistic value carries the `current` it was based on. `shown` prefers it
  // ONLY while `current` hasn't moved — so once the server state changes (our
  // own mutation landing via the poll, OR a leader's on-behalf change), the
  // fresh `current` supersedes and the optimistic value can never stale-lock.
  const [optimistic, setOptimistic] = useState<{
    value: AttendanceState;
    base: AttendanceState | null;
  } | null>(null);
  const [eta, setEta] = useState<number>(currentEta ?? 15);
  const cur = current ?? null;
  const shown = optimistic && optimistic.base === cur ? optimistic.value : cur;

  const mutate = api.calendar.setStatus.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.calendar.eventsInRange.invalidate(),
        utils.calendar.eventDetail.invalidate({ eventId }),
      ]);
      onChanged?.();
    },
    onError: () => setOptimistic(null), // roll back the optimistic highlight
  });

  const pick = (state: AttendanceState) => {
    if (disabled) return;
    setOptimistic({ value: state, base: cur });
    mutate.mutate({
      eventId,
      state: state as "CONFIRM" | "TENTATIVE" | "LATE" | "ABSENT",
      etaMinutes: state === "LATE" ? eta : null,
      clientActionId: newActionId(),
    });
  };

  const btn = size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-2.5 text-sm";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {PICKABLE.map((s) => {
          const meta = STATE_META[s];
          const active = shown === s;
          return (
            <button
              key={s}
              type="button"
              disabled={disabled || mutate.isPending}
              onClick={() => pick(s)}
              aria-pressed={active}
              className={cn(
                "border-border bg-background inline-flex items-center gap-1 rounded-md border font-medium transition-colors disabled:opacity-50",
                btn,
                active
                  ? `${meta.className} ring-1 ring-inset ${meta.ring} bg-muted`
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <span aria-hidden>{meta.glyph}</span>
              {meta.label}
            </button>
          );
        })}
      </div>
      {shown === "LATE" && (
        <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
          ETA
          <input
            type="number"
            min={0}
            max={600}
            step={5}
            value={eta}
            onChange={(e) => setEta(Math.max(0, Math.min(600, Number(e.target.value) || 0)))}
            className="border-border bg-background w-16 rounded border px-1.5 py-0.5"
          />
          min late
          {/* Explicit Set — no onBlur mutation, so editing the field doesn't
              fire a redundant signup write per blur. */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={mutate.isPending}
            onClick={() => pick("LATE")}
          >
            Set
          </Button>
        </label>
      )}
      {mutate.error && (
        <p className="text-destructive text-xs" role="alert">
          {mutate.error.message}
        </p>
      )}
    </div>
  );
}

/** Role-segmented comp-readiness bar. */
export function ReadinessBar({
  readiness,
}: {
  readiness: {
    byRole: { TANK: number; HEAL: number; DPS: number };
    target: { tanks: number; healers: number; dps: number };
    present: number;
    total: number;
    gaps: Partial<{ tanks: number; healers: number; dps: number }>;
    met: boolean;
  };
}) {
  const seg = (
    label: string,
    have: number,
    want: number,
  ) => {
    const ok = have >= want;
    return (
      <span
        className={cn(
          "rounded px-1.5 py-0.5 text-xs font-medium tabular-nums",
          ok ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500",
        )}
        title={`${label}: ${have} of ${want}`}
      >
        {label} {have}/{want}
      </span>
    );
  };
  const gapText = Object.entries(readiness.gaps)
    .map(([k, v]) => `${v} ${k === "healers" ? "healer" : k === "tanks" ? "tank" : "dps"}${v! > 1 ? "s" : ""}`)
    .join(", ");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {seg("Tanks", readiness.byRole.TANK, readiness.target.tanks)}
      {seg("Healers", readiness.byRole.HEAL, readiness.target.healers)}
      {seg("DPS", readiness.byRole.DPS, readiness.target.dps)}
      <span className="text-muted-foreground text-xs">
        · {readiness.present}/{readiness.total} in
        {!readiness.met && gapText && <span className="text-amber-500"> · needs {gapText}</span>}
        {readiness.met && <span className="text-emerald-500"> · comp met</span>}
      </span>
    </div>
  );
}
