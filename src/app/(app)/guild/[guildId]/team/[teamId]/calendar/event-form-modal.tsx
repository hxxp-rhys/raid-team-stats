"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

/** BYDAY token for a "YYYY-MM-DD" string (used to preselect the repeat day). */
function bydayOf(dateStr: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // Sun=0
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][dow] ?? null;
}

type Initial = {
  title: string;
  date: string;
  startTime: string;
  durationMin: number;
  difficulty: Difficulty;
  notes: string;
  targetZoneIds: number[];
  targetEncounterIds: number[];
};

const EMPTY: Initial = {
  title: "",
  date: "",
  startTime: "19:00",
  durationMin: 180,
  difficulty: "Mythic",
  notes: "",
  targetZoneIds: [],
  targetEncounterIds: [],
};

export function EventFormModal({
  raidTeamId,
  timezone,
  editEventId,
  open,
  onClose,
  onSaved,
}: {
  raidTeamId: string;
  timezone: string;
  editEventId: string | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editEventId ? "Edit raid" : "Schedule a raid"}
      description={`Times are in the team timezone (${timezone}).`}
      hideDefaultFooter
    >
      {open && (
        <Loader
          raidTeamId={raidTeamId}
          timezone={timezone}
          editEventId={editEventId}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </Modal>
  );
}

/** Loads the event-to-edit (if any), then mounts a keyed form seeded from it. */
function Loader({
  raidTeamId,
  timezone,
  editEventId,
  onClose,
  onSaved,
}: {
  raidTeamId: string;
  timezone: string;
  editEventId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = api.calendar.eventDetail.useQuery(
    { eventId: editEventId ?? "" },
    { enabled: !!editEventId },
  );

  if (editEventId) {
    if (existing.isPending) {
      return <p className="text-muted-foreground text-sm">Loading…</p>;
    }
    if (existing.error || !existing.data) {
      return (
        <p className="text-destructive text-sm" role="alert">
          {existing.error?.message ?? "Not found"}
        </p>
      );
    }
    const e = existing.data.event;
    const initial: Initial = {
      title: e.title,
      date: e.occurrenceDate,
      startTime: e.localTime,
      durationMin: e.durationMin,
      difficulty: e.difficulty as Difficulty,
      notes: e.notes ?? "",
      targetZoneIds: e.targetZoneIds ?? [],
      targetEncounterIds: e.targetEncounterIds ?? [],
    };
    return (
      <Fields
        key={editEventId}
        raidTeamId={raidTeamId}
        timezone={timezone}
        editEventId={editEventId}
        isSeriesMember={!!e.seriesId}
        initial={initial}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
  }

  return (
    <Fields
      key="new"
      raidTeamId={raidTeamId}
      timezone={timezone}
      editEventId={null}
      isSeriesMember={false}
      initial={EMPTY}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

/** Pure form, seeded once from `initial` via useState initializers (no effect). */
function Fields({
  raidTeamId,
  timezone,
  editEventId,
  isSeriesMember,
  initial,
  onClose,
  onSaved,
}: {
  raidTeamId: string;
  timezone: string;
  editEventId: string | null;
  isSeriesMember: boolean;
  initial: Initial;
  onClose: () => void;
  onSaved: () => void;
}) {
  const utils = api.useUtils();
  const [title, setTitle] = useState(initial.title);
  const [date, setDate] = useState(initial.date);
  const [startTime, setStartTime] = useState(initial.startTime);
  const [durationMin, setDurationMin] = useState(initial.durationMin);
  const [difficulty, setDifficulty] = useState<Difficulty>(initial.difficulty);
  const [notes, setNotes] = useState(initial.notes);
  // Raid-lead targeting: up to 2 zones; selecting one reveals its boss list.
  const [targetZoneIds, setTargetZoneIds] = useState<number[]>(initial.targetZoneIds);
  const [targetEncounterIds, setTargetEncounterIds] = useState<number[]>(
    initial.targetEncounterIds,
  );
  const zonesQ = api.calendar.targetableZones.useQuery({ raidTeamId });
  const zones = zonesQ.data?.zones ?? [];

  const toggleZone = (id: number) =>
    setTargetZoneIds((cur) => {
      if (cur.includes(id)) return cur.filter((z) => z !== id);
      if (cur.length >= 2) return cur; // cap at 2
      return [...cur, id];
    });
  const toggleEncounter = (id: number) =>
    setTargetEncounterIds((cur) =>
      cur.includes(id) ? cur.filter((e) => e !== id) : [...cur, id],
    );

  // Recurrence (create-only). Editing a single occurrence never recurs.
  const [repeat, setRepeat] = useState(false);
  const [byday, setByday] = useState<string[]>([]);
  const [endDate, setEndDate] = useState("");

  const toggleDay = (token: string) =>
    setByday((cur) =>
      cur.includes(token) ? cur.filter((t) => t !== token) : [...cur, token],
    );
  // First time the user turns on Repeat, preselect the chosen date's weekday.
  const enableRepeat = (on: boolean) => {
    setRepeat(on);
    if (on && byday.length === 0) {
      const d = bydayOf(date);
      if (d) setByday([d]);
    }
  };

  const create = api.calendar.createEvent.useMutation({
    onSuccess: async () => {
      await utils.calendar.eventsInRange.invalidate({ raidTeamId });
      onSaved();
      onClose();
    },
  });
  const createSeries = api.calendar.createSeries.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.calendar.eventsInRange.invalidate({ raidTeamId }),
        utils.calendar.listSeries.invalidate({ raidTeamId }),
      ]);
      onSaved();
      onClose();
    },
  });
  const update = api.calendar.updateEvent.useMutation({
    onSuccess: async () => {
      await utils.calendar.eventsInRange.invalidate({ raidTeamId });
      if (editEventId) await utils.calendar.eventDetail.invalidate({ eventId: editEventId });
      onSaved();
      onClose();
    },
  });

  const pending = create.isPending || update.isPending || createSeries.isPending;
  const err = create.error ?? update.error ?? createSeries.error;
  const recurring = !editEventId && repeat;
  // For a recurring series, the "Until" date (if set) must be on/after the
  // start date — otherwise the server rejects it after a round-trip.
  const endBeforeStart = recurring && !!endDate && endDate < date;
  const canSubmit =
    !!title.trim() &&
    !!date &&
    (!recurring || (byday.length > 0 && !endBeforeStart));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !date) return;
    // Keep only boss selections that belong to a currently-targeted raid —
    // deselecting a raid must not strand its bosses on the event.
    const validEncounterIds = new Set(
      targetZoneIds.flatMap(
        (zid) =>
          zones
            .find((z) => z.blizzardInstanceId === zid)
            ?.encounters.map((e) => e.id) ?? [],
      ),
    );
    const encounters = targetEncounterIds.filter((id) =>
      validEncounterIds.has(id),
    );
    if (editEventId) {
      update.mutate({
        eventId: editEventId,
        title: title.trim(),
        date,
        startTime,
        durationMin,
        difficulty,
        notes: notes.trim() || null,
        targetZoneIds,
        targetEncounterIds: encounters,
      });
    } else if (recurring) {
      if (byday.length === 0) return;
      createSeries.mutate({
        raidTeamId,
        title: title.trim(),
        byday,
        startTime,
        durationMin,
        difficulty,
        notes: notes.trim() || undefined,
        startDate: date,
        endDate: endDate || null,
        targetZoneIds,
        targetEncounterIds: encounters,
      });
    } else {
      create.mutate({
        raidTeamId,
        title: title.trim(),
        date,
        startTime,
        durationMin,
        difficulty,
        notes: notes.trim() || undefined,
        targetZoneIds,
        targetEncounterIds: encounters,
      });
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <div className="space-y-1.5">
        <Label htmlFor="ev-title">Title</Label>
        <Input
          id="ev-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Team — Mythic progression"
          maxLength={120}
          required
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="ev-date">{recurring ? "Start date" : "Date"}</Label>
          <Input
            id="ev-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={isSeriesMember}
            required
          />
          {isSeriesMember && (
            <p className="text-muted-foreground text-xs">
              Recurring occurrence — the date is fixed. Cancel it to reschedule.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ev-time">Start ({timezone})</Label>
          <Input id="ev-time" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="ev-dur">Duration (min)</Label>
          <Input
            id="ev-dur"
            type="number"
            min={15}
            max={720}
            step={15}
            value={durationMin}
            onChange={(e) => setDurationMin(Math.max(15, Math.min(720, Number(e.target.value) || 180)))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ev-diff">Difficulty</Label>
          <select
            id="ev-diff"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as Difficulty)}
            className="border-border bg-background h-9 w-full rounded-md border px-2 text-sm"
          >
            {(["Mythic", "Heroic", "Normal", "LFR"] as const).map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
      </div>
      {zones.length > 0 && (
        <div className="border-border space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <Label>Target raid {targetZoneIds.length > 0 ? "" : "(optional)"}</Label>
            <span className="text-muted-foreground text-xs">pick up to 2</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {zones.map((z) => {
              const on = targetZoneIds.includes(z.blizzardInstanceId);
              const atCap = !on && targetZoneIds.length >= 2;
              return (
                <button
                  key={z.blizzardInstanceId}
                  type="button"
                  onClick={() => toggleZone(z.blizzardInstanceId)}
                  aria-pressed={on}
                  disabled={atCap}
                  className={
                    "rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40 " +
                    (on
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted")
                  }
                >
                  {z.name}
                </button>
              );
            })}
          </div>
          {targetZoneIds.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-muted-foreground text-xs">Bosses (optional)</p>
              {/* One boss group per TARGETED raid — each raid shows only its
                  own bosses (labelled when more than one raid is targeted). */}
              {targetZoneIds.map((zid) => {
                const zone = zones.find((z) => z.blizzardInstanceId === zid);
                if (!zone || zone.encounters.length === 0) return null;
                return (
                  <div key={zid} className="space-y-0.5">
                    {targetZoneIds.length > 1 && (
                      <p className="text-muted-foreground text-[10px] font-medium uppercase">
                        {zone.name}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {zone.encounters.map((b) => (
                        <label
                          key={b.id}
                          className="flex items-center gap-1.5 text-xs"
                        >
                          <input
                            type="checkbox"
                            className="accent-primary h-3.5 w-3.5"
                            checked={targetEncounterIds.includes(b.id)}
                            onChange={() => toggleEncounter(b.id)}
                          />
                          {b.name}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {!editEventId && (
        <div className="border-border space-y-2 rounded-md border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={repeat}
              onChange={(e) => enableRepeat(e.target.checked)}
              className="accent-primary h-4 w-4"
            />
            Repeat weekly
          </label>
          {repeat && (
            <div className="space-y-2">
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
              <div className="flex items-center gap-2">
                <Label htmlFor="ev-until" className="text-xs">
                  Until (optional)
                </Label>
                <Input
                  id="ev-until"
                  type="date"
                  value={endDate}
                  min={date || undefined}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="h-8 w-auto"
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
              {byday.length === 0 && (
                <p className="text-amber-500 text-xs">Pick at least one weekday.</p>
              )}
              {endBeforeStart && (
                <p className="text-amber-500 text-xs">
                  “Until” must be on or after the start date.
                </p>
              )}
            </div>
          )}
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="ev-notes">Notes (optional)</Label>
        <textarea
          id="ev-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          maxLength={4000}
          className="border-border bg-background w-full rounded-md border px-2 py-1.5 text-sm"
          placeholder="Tactics, loot rules, links…"
        />
      </div>
      {err && <p className="text-destructive text-xs" role="alert">{err.message}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !canSubmit}>
          {pending
            ? "Saving…"
            : editEventId
              ? "Save changes"
              : recurring
                ? "Create schedule"
                : "Schedule raid"}
        </Button>
      </div>
    </form>
  );
}
