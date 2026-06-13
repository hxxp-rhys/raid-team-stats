"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { localDateInTz } from "@/lib/calendar/time";

type Difficulty = "Mythic" | "Heroic" | "Normal" | "LFR";

const WEEKDAYS: { token: string; label: string }[] = [
  { token: "MO", label: "Mon" },
  { token: "TU", label: "Tue" },
  { token: "WE", label: "Wed" },
  { token: "TH", label: "Thu" },
  { token: "FR", label: "Fri" },
  { token: "SA", label: "Sat" },
  { token: "SU", label: "Sun" },
];
const DAY_LABEL: Record<string, string> = Object.fromEntries(
  WEEKDAYS.map((d) => [d.token, d.label]),
);
const DAY_ORDER: Record<string, number> = Object.fromEntries(
  WEEKDAYS.map((d, i) => [d.token, i]),
);

type Series = {
  id: string;
  title: string;
  difficulty: string;
  raidSize: number | null;
  byday: string[];
  startLocal: string;
  durationMin: number;
  timezone: string;
  notes: string | null;
  endsOn: Date | string | null;
};

function scheduleSummary(s: Series): string {
  const days = [...s.byday]
    .sort((a, b) => (DAY_ORDER[a] ?? 9) - (DAY_ORDER[b] ?? 9))
    .map((t) => DAY_LABEL[t] ?? t)
    .join(", ");
  const hrs = s.durationMin / 60;
  const dur = Number.isInteger(hrs) ? `${hrs}h` : `${s.durationMin}m`;
  return `${days || "—"} · ${s.startLocal} · ${s.difficulty} · ${dur}`;
}

export function SeriesManagerModal({
  raidTeamId,
  timezone,
  canLead,
  open,
  onClose,
}: {
  raidTeamId: string;
  timezone: string;
  canLead: boolean;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Recurring schedules"
      description={`Weekly raid schedules (times in ${timezone}).`}
    >
      {open && <Body raidTeamId={raidTeamId} canLead={canLead} onClose={onClose} />}
    </Modal>
  );
}

function Body({
  raidTeamId,
  canLead,
  onClose,
}: {
  raidTeamId: string;
  canLead: boolean;
  onClose: () => void;
}) {
  const list = api.calendar.listSeries.useQuery({ raidTeamId });
  const [editingId, setEditingId] = useState<string | null>(null);

  if (list.isPending) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (list.error) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {list.error.message}
      </p>
    );
  }
  if (list.data.series.length === 0) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          No recurring schedules yet. Use “＋ Schedule raid” and turn on{" "}
          <span className="font-medium">Repeat weekly</span> to create one.
        </p>
        <div className="flex justify-end">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <ul className="divide-border divide-y">
        {list.data.series.map((s) => (
          <SeriesRow
            key={s.id}
            series={s as Series}
            raidTeamId={raidTeamId}
            canLead={canLead}
            editing={editingId === s.id}
            onToggleEdit={() => setEditingId((cur) => (cur === s.id ? null : s.id))}
            onDone={() => setEditingId(null)}
          />
        ))}
      </ul>
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

function SeriesRow({
  series,
  raidTeamId,
  canLead,
  editing,
  onToggleEdit,
  onDone,
}: {
  series: Series;
  raidTeamId: string;
  canLead: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  onDone: () => void;
}) {
  const utils = api.useUtils();
  const endSeries = api.calendar.endSeries.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.calendar.listSeries.invalidate({ raidTeamId }),
        utils.calendar.eventsInRange.invalidate({ raidTeamId }),
      ]);
      onDone();
    },
  });

  const until =
    series.endsOn != null
      ? ` · until ${localDateInTz(new Date(series.endsOn), series.timezone)}`
      : "";

  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">
            {series.title}
            {series.raidSize ? (
              <span className="text-muted-foreground font-normal"> · {series.raidSize}-man</span>
            ) : null}
          </p>
          <p className="text-muted-foreground text-xs">
            {scheduleSummary(series)}
            {until}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground text-xs underline decoration-dotted"
            onClick={onToggleEdit}
          >
            {editing ? "close" : "edit"}
          </button>
          {canLead && (
            <button
              type="button"
              disabled={endSeries.isPending}
              className="text-destructive/80 hover:text-destructive text-xs underline decoration-dotted disabled:opacity-50"
              onClick={() => {
                if (
                  window.confirm(
                    "End this recurring schedule? Future occurrences with signups are cancelled (kept for history); empty ones are removed. Past raids are untouched.",
                  )
                ) {
                  endSeries.mutate({ seriesId: series.id });
                }
              }}
            >
              end
            </button>
          )}
        </div>
      </div>
      {endSeries.error && (
        <p className="text-destructive mt-1 text-xs" role="alert">
          {endSeries.error.message}
        </p>
      )}
      {editing && (
        <SeriesEditor
          key={series.id}
          series={series}
          raidTeamId={raidTeamId}
          onDone={onDone}
        />
      )}
    </li>
  );
}

/** Inline series editor, seeded once from the series via useState initializers. */
function SeriesEditor({
  series,
  raidTeamId,
  onDone,
}: {
  series: Series;
  raidTeamId: string;
  onDone: () => void;
}) {
  const utils = api.useUtils();
  const [title, setTitle] = useState(series.title);
  const [byday, setByday] = useState<string[]>(series.byday);
  const [startTime, setStartTime] = useState(series.startLocal);
  const [durationMin, setDurationMin] = useState(series.durationMin);
  const [difficulty, setDifficulty] = useState<Difficulty>(series.difficulty as Difficulty);
  const [notes, setNotes] = useState(series.notes ?? "");
  const [endDate, setEndDate] = useState(
    series.endsOn != null
      ? localDateInTz(new Date(series.endsOn), series.timezone)
      : "",
  );

  const toggleDay = (token: string) =>
    setByday((cur) =>
      cur.includes(token) ? cur.filter((t) => t !== token) : [...cur, token],
    );

  const save = api.calendar.updateSeries.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.calendar.listSeries.invalidate({ raidTeamId }),
        utils.calendar.eventsInRange.invalidate({ raidTeamId }),
        utils.calendar.eventDetail.invalidate(),
      ]);
      onDone();
    },
  });

  // An "Until" cutoff must be in the future — a past date would silently wipe
  // every remaining occurrence (the explicit "end" button is the way to stop a
  // series now). The server independently rejects end < series-start.
  const todayStr = localDateInTz(new Date(), series.timezone);
  const endInPast = !!endDate && endDate < todayStr;
  const canSave = !!title.trim() && byday.length > 0 && !endInPast;

  return (
    <form
      className="border-border bg-muted/30 mt-2 space-y-3 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSave) return;
        save.mutate({
          seriesId: series.id,
          title: title.trim(),
          byday,
          startTime,
          durationMin,
          difficulty,
          notes: notes.trim() || null,
          endDate: endDate || null,
        });
      }}
    >
      <div className="space-y-1.5">
        <Label className="text-xs">Title</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Days</Label>
        <div className="flex flex-wrap gap-1">
          {WEEKDAYS.map((d) => {
            const on = byday.includes(d.token);
            return (
              <button
                key={d.token}
                type="button"
                onClick={() => toggleDay(d.token)}
                aria-pressed={on}
                className={
                  "rounded-md border px-2 py-1 text-xs font-medium transition-colors " +
                  (on
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted")
                }
              >
                {d.label}
              </button>
            );
          })}
        </div>
        {byday.length === 0 && (
          <p className="text-amber-500 text-xs">Pick at least one weekday.</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Start time</Label>
          <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Duration (min)</Label>
          <Input
            type="number"
            min={15}
            max={720}
            step={15}
            value={durationMin}
            onChange={(e) => setDurationMin(Math.max(15, Math.min(720, Number(e.target.value) || 180)))}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Difficulty</Label>
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as Difficulty)}
            className="border-border bg-background h-9 w-full rounded-md border px-2 text-sm"
          >
            {(["Mythic", "Heroic", "Normal", "LFR"] as const).map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Until (optional)</Label>
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={endDate}
              min={todayStr}
              onChange={(e) => setEndDate(e.target.value)}
            />
            {endDate && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground text-xs underline"
                onClick={() => setEndDate("")}
              >
                clear
              </button>
            )}
          </div>
          {endInPast && (
            <p className="text-amber-500 text-xs">
              “Until” must be today or later (use “end” to stop the series now).
            </p>
          )}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Notes (optional)</Label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={4000}
          className="border-border bg-background w-full rounded-md border px-2 py-1.5 text-sm"
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Applies to future occurrences. Occurrences you edited or locked, and past
        raids, are left unchanged.
      </p>
      {save.error && (
        <p className="text-destructive text-xs" role="alert">{save.error.message}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="submit" size="sm" disabled={save.isPending || !canSave}>
          {save.isPending ? "Saving…" : "Save series"}
        </Button>
      </div>
    </form>
  );
}
