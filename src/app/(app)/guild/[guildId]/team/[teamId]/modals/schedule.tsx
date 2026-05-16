"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { api } from "@/lib/trpc-client";

const INTERVAL_HOURS = [4, 6, 12, 24, 28, 72] as const;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

type IntervalHours = (typeof INTERVAL_HOURS)[number];
type Schedule =
  | { kind: "interval"; hours: IntervalHours }
  | { kind: "weekly"; dayOfWeek: number; hour: number; minute: number }
  | null;

/**
 * Auto-refresh schedule editor. Writes RaidTeam.refreshSchedule via
 * `raidTeam.setRefreshSettings`; the worker's 5-minute sweeper fires team
 * refreshes when a schedule comes due.
 *
 * The form (ScheduleForm) is mounted only once the persisted settings have
 * loaded and is keyed by the loaded value, so it initializes its fields via
 * lazy useState rather than a hydrate-in-effect (avoids
 * react-hooks/set-state-in-effect).
 */
export function ScheduleModal({
  open,
  onClose,
  raidTeamId,
}: {
  open: boolean;
  onClose: () => void;
  raidTeamId: string;
}) {
  const utils = api.useUtils();
  const settings = api.raidTeam.refreshSettings.useQuery(
    { raidTeamId },
    { enabled: open },
  );
  const save = api.raidTeam.setRefreshSettings.useMutation({
    onSuccess: () => {
      utils.raidTeam.refreshSettings.invalidate({ raidTeamId });
      onClose();
    },
  });

  const schedule = (settings.data?.refreshSchedule ?? null) as Schedule;
  // A stable key for the loaded schedule so ScheduleForm re-mounts (and thus
  // re-seeds its lazy useState) if the persisted value changes.
  const formKey = settings.data
    ? JSON.stringify(schedule)
    : "loading";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Auto-refresh schedule"
      description="Automatically sync raid-team data on a recurring schedule."
    >
      <div className="space-y-4 text-sm">
        {settings.isPending || !settings.data ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <ScheduleForm
            key={formKey}
            initial={schedule}
            saving={save.isPending}
            error={save.error?.message ?? null}
            onSave={(refreshSchedule) =>
              save.mutate({ raidTeamId, refreshSchedule })
            }
          />
        )}
      </div>
    </Modal>
  );
}

function ScheduleForm({
  initial,
  saving,
  error,
  onSave,
}: {
  initial: Schedule;
  saving: boolean;
  error: string | null;
  onSave: (s: Schedule) => void;
}) {
  // Lazy initializers seed straight from the loaded value — no effect.
  const [mode, setMode] = useState<"none" | "interval" | "weekly">(() =>
    !initial ? "none" : initial.kind,
  );
  const [intervalHours, setIntervalHours] = useState<IntervalHours>(() =>
    initial && initial.kind === "interval"
      ? (initial.hours as IntervalHours)
      : 24,
  );
  const [weeklyDay, setWeeklyDay] = useState(() =>
    initial && initial.kind === "weekly" ? initial.dayOfWeek : 2,
  );
  const [weeklyHour, setWeeklyHour] = useState(() =>
    initial && initial.kind === "weekly" ? initial.hour : 6,
  );
  const [weeklyMinute, setWeeklyMinute] = useState(() =>
    initial && initial.kind === "weekly" ? initial.minute : 0,
  );

  const submit = () => {
    const next: Schedule =
      mode === "none"
        ? null
        : mode === "interval"
          ? { kind: "interval", hours: intervalHours }
          : {
              kind: "weekly",
              dayOfWeek: weeklyDay,
              hour: weeklyHour,
              minute: weeklyMinute,
            };
    onSave(next);
  };

  return (
    <>
      <fieldset className="space-y-3">
        <Label className="block">Schedule</Label>
        <div className="flex flex-wrap gap-4">
          {(["none", "interval", "weekly"] as const).map((m) => (
            <label key={m} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="schedule-mode"
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              {m === "none"
                ? "Off"
                : m === "interval"
                  ? "Every N hours"
                  : "Weekly"}
            </label>
          ))}
        </div>

        {mode === "interval" && (
          <div className="flex items-center gap-2">
            <span>Every</span>
            <select
              value={intervalHours}
              onChange={(e) =>
                setIntervalHours(Number(e.target.value) as IntervalHours)
              }
              className="border-border bg-background h-8 rounded-md border px-2"
            >
              {INTERVAL_HOURS.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
            <span>hours</span>
          </div>
        )}

        {mode === "weekly" && (
          <div className="flex flex-wrap items-center gap-2">
            <span>On</span>
            <select
              value={weeklyDay}
              onChange={(e) => setWeeklyDay(Number(e.target.value))}
              className="border-border bg-background h-8 rounded-md border px-2"
            >
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
            <span>at</span>
            <select
              value={weeklyHour}
              onChange={(e) => setWeeklyHour(Number(e.target.value))}
              className="border-border bg-background h-8 rounded-md border px-2"
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>
                  {i.toString().padStart(2, "0")}
                </option>
              ))}
            </select>
            <span>:</span>
            <select
              value={weeklyMinute}
              onChange={(e) => setWeeklyMinute(Number(e.target.value))}
              className="border-border bg-background h-8 rounded-md border px-2"
            >
              {[0, 15, 30, 45].map((m) => (
                <option key={m} value={m}>
                  {m.toString().padStart(2, "0")}
                </option>
              ))}
            </select>
            <span className="text-muted-foreground text-xs">local</span>
          </div>
        )}
      </fieldset>

      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={saving}>
          {saving ? "Saving…" : "Save schedule"}
        </Button>
      </div>
      {error && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
