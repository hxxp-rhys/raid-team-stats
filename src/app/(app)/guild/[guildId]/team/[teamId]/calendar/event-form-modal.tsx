"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Difficulty = "Mythic" | "Heroic" | "Normal" | "LFR";

type Initial = {
  title: string;
  date: string;
  startTime: string;
  durationMin: number;
  difficulty: Difficulty;
  notes: string;
};

const EMPTY: Initial = {
  title: "",
  date: "",
  startTime: "19:00",
  durationMin: 180,
  difficulty: "Mythic",
  notes: "",
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
    };
    return (
      <Fields
        key={editEventId}
        raidTeamId={raidTeamId}
        timezone={timezone}
        editEventId={editEventId}
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
  initial,
  onClose,
  onSaved,
}: {
  raidTeamId: string;
  timezone: string;
  editEventId: string | null;
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

  const create = api.calendar.createEvent.useMutation({
    onSuccess: async () => {
      await utils.calendar.eventsInRange.invalidate({ raidTeamId });
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

  const pending = create.isPending || update.isPending;
  const err = create.error ?? update.error;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !date) return;
    if (editEventId) {
      update.mutate({
        eventId: editEventId,
        title: title.trim(),
        date,
        startTime,
        durationMin,
        difficulty,
        notes: notes.trim() || null,
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
          <Label htmlFor="ev-date">Date</Label>
          <Input id="ev-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
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
        <Button type="submit" disabled={pending || !title.trim() || !date}>
          {pending ? "Saving…" : editEventId ? "Save changes" : "Schedule raid"}
        </Button>
      </div>
    </form>
  );
}
