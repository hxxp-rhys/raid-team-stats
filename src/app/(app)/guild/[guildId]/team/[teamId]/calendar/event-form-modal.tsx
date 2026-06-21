"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/trpc-client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RaidTargetItem } from "@/lib/calendar/raid-target";

type Difficulty = "Mythic" | "Heroic" | "Normal" | "LFR";

/** A targetable raid as returned by `calendar.targetableZones`. */
type TargetZone = {
  blizzardInstanceId: number;
  name: string;
  encounters: { id: number; name: string }[];
};

/**
 * Rebuild an ordered target list from the legacy flat arrays — for editing an
 * event saved BEFORE `targetOrder` existed. Needs the zone dataset to map a
 * boss to its raid. A targeted zone with no selected boss becomes a whole-raid
 * entry; zones keep their array order, bosses their in-raid order.
 */
function synthesizeOrder(
  zoneIds: number[],
  encounterIds: number[],
  zones: TargetZone[],
): RaidTargetItem[] {
  const items: RaidTargetItem[] = [];
  const encSet = new Set(encounterIds);
  for (const zid of zoneIds) {
    const zone = zones.find((z) => z.blizzardInstanceId === zid);
    const bosses = zone?.encounters.filter((b) => encSet.has(b.id)) ?? [];
    if (bosses.length > 0) {
      for (const b of bosses) items.push({ type: "encounter", id: b.id, zoneId: zid });
    } else {
      items.push({ type: "zone", id: zid, zoneId: zid });
    }
  }
  // Defensive: a selected boss whose zone wasn't listed in zoneIds.
  for (const eid of encounterIds) {
    if (items.some((it) => it.type === "encounter" && it.id === eid)) continue;
    const zone = zones.find((z) => z.encounters.some((b) => b.id === eid));
    if (zone) items.push({ type: "encounter", id: eid, zoneId: zone.blizzardInstanceId });
  }
  return items;
}

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
  // Authoritative ordered target list. The legacy flat arrays are kept so a
  // pre-`targetOrder` event can be re-hydrated into the order on edit.
  targetOrder: RaidTargetItem[];
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
  targetOrder: [],
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
      targetOrder: e.targetOrder ?? [],
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
  // Raid-lead targeting: an ORDERED list of whole raids and/or single bosses
  // (the planned kill order). Built via the "Add raid" lightbox below.
  const zonesQ = api.calendar.targetableZones.useQuery({ raidTeamId });
  const zones = zonesQ.data?.zones ?? [];
  const [order, setOrder] = useState<RaidTargetItem[]>(initial.targetOrder);

  // Re-hydrate a pre-`targetOrder` event: synthesize the order from its legacy
  // flat arrays once the zone dataset (needed to map a boss → its raid) loads.
  // `hydrated` starts true when the event already had an order, so this only
  // ever fires for old events and runs once.
  const [legacyZoneIds] = useState(initial.targetZoneIds);
  const [legacyEncounterIds] = useState(initial.targetEncounterIds);
  const [hydrated, setHydrated] = useState(initial.targetOrder.length > 0);
  // Hydrate a pre-`targetOrder` event the first render after the zone dataset
  // loads, by adjusting state DURING render (React's sanctioned "derive from
  // changed inputs" pattern — avoids a setState-in-effect cascade). Guarded by
  // `hydrated`, so it runs at most once.
  if (!hydrated && zones.length > 0) {
    setHydrated(true);
    if (
      order.length === 0 &&
      (legacyZoneIds.length > 0 || legacyEncounterIds.length > 0)
    ) {
      setOrder(synthesizeOrder(legacyZoneIds, legacyEncounterIds, zones));
    }
  }

  // "Add raid" picker — a self-contained lightbox (the email-editor pattern): a
  // nested shared Modal's backdrop/Escape would also dismiss this whole form.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickZone, setPickZone] = useState<number | null>(null);
  const [pickBosses, setPickBosses] = useState<number[]>([]);
  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setPickerOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [pickerOpen]);

  const openPicker = () => {
    setPickZone(null);
    setPickBosses([]);
    setPickerOpen(true);
  };
  const togglePickBoss = (id: number) =>
    setPickBosses((cur) =>
      cur.includes(id) ? cur.filter((b) => b !== id) : [...cur, id],
    );
  const confirmPick = () => {
    if (pickZone === null) return;
    const zone = zones.find((z) => z.blizzardInstanceId === pickZone);
    setOrder((cur) => {
      const next = [...cur];
      if (pickBosses.length === 0) {
        // Whole raid — a single entry (deduped).
        if (!next.some((it) => it.type === "zone" && it.zoneId === pickZone)) {
          next.push({ type: "zone", id: pickZone, zoneId: pickZone });
        }
      } else {
        // Selected bosses in the raid's own encounter order (deduped).
        for (const b of zone?.encounters ?? []) {
          if (!pickBosses.includes(b.id)) continue;
          if (next.some((it) => it.type === "encounter" && it.id === b.id)) continue;
          next.push({ type: "encounter", id: b.id, zoneId: pickZone });
        }
      }
      return next;
    });
    setPickerOpen(false);
  };

  const moveItem = (idx: number, dir: -1 | 1) =>
    setOrder((cur) => {
      const j = idx + dir;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[idx], next[j]] = [next[j]!, next[idx]!];
      return next;
    });
  const removeItem = (idx: number) =>
    setOrder((cur) => cur.filter((_, i) => i !== idx));

  // Human label for an ordered entry, resolved from the zone dataset.
  const labelFor = (item: RaidTargetItem): string => {
    const zone = zones.find((z) => z.blizzardInstanceId === item.zoneId);
    const zoneName = zone?.name ?? `Raid ${item.zoneId}`;
    if (item.type === "zone") return `${zoneName} — whole raid`;
    const boss = zone?.encounters.find((b) => b.id === item.id);
    return `${zoneName}: ${boss?.name ?? `Boss ${item.id}`}`;
  };

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
    if (editEventId) {
      update.mutate({
        eventId: editEventId,
        title: title.trim(),
        date,
        startTime,
        durationMin,
        difficulty,
        notes: notes.trim() || null,
        // Only send targetOrder once the order has HYDRATED. Editing a
        // pre-targetOrder event before the zone dataset loads (or when it's
        // unavailable — unreleased tier / API down) leaves `order` empty; the
        // server leaves targets untouched when targetOrder is omitted, so this
        // prevents a save from silently wiping the event's existing targets.
        ...(hydrated ? { targetOrder: order } : {}),
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
        targetOrder: order,
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
        targetOrder: order,
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
            <Label>Target raid {order.length > 0 ? "" : "(optional)"}</Label>
            <Button type="button" size="sm" variant="outline" onClick={openPicker}>
              ＋ Add raid
            </Button>
          </div>
          {order.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No target set. Add a raid (or specific bosses) to set the planned
              order — the first two entries drive the month-view art.
            </p>
          ) : (
            <ol className="space-y-1">
              {order.map((item, idx) => (
                <li
                  key={`${item.type}-${item.id}-${idx}`}
                  className="border-border bg-muted/30 flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
                >
                  <span className="text-muted-foreground w-5 shrink-0 tabular-nums">
                    {idx + 1}.
                  </span>
                  <span className="min-w-0 flex-1 truncate">{labelFor(item)}</span>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => moveItem(idx, -1)}
                      disabled={idx === 0}
                      aria-label="Move up"
                      className="border-border hover:bg-muted rounded border px-1 leading-none disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveItem(idx, 1)}
                      disabled={idx === order.length - 1}
                      aria-label="Move down"
                      className="border-border hover:bg-muted rounded border px-1 leading-none disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => removeItem(idx)}
                      aria-label="Remove"
                      className="border-border hover:bg-destructive/10 hover:text-destructive rounded border px-1 leading-none"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ol>
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

      {/* "Add raid" lightbox: pick one raid, then optionally specific bosses.
          Self-contained overlay (z above the form Modal) with a capture-phase
          Escape so closing it never dismisses the underlying form. */}
      {pickerOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Add a target raid"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget) setPickerOpen(false);
          }}
        >
          <div className="border-border bg-card max-h-[85vh] w-full max-w-md space-y-3 overflow-y-auto rounded-lg border p-4 text-sm shadow-2xl">
            <div>
              <h2 className="text-base font-semibold">Add a target raid</h2>
              <p className="text-muted-foreground text-xs">
                Pick a raid, then optionally tick specific bosses. Leave bosses
                unticked to target the whole raid.
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs font-medium uppercase">
                Raid
              </p>
              <div className="flex flex-wrap gap-1">
                {zones.map((z) => {
                  const on = pickZone === z.blizzardInstanceId;
                  return (
                    <button
                      key={z.blizzardInstanceId}
                      type="button"
                      onClick={() => {
                        setPickZone(z.blizzardInstanceId);
                        setPickBosses([]);
                      }}
                      aria-pressed={on}
                      className={
                        "rounded-md border px-2 py-1 text-xs font-medium transition-colors " +
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
            </div>
            {pickZone !== null &&
              (() => {
                const zone = zones.find((z) => z.blizzardInstanceId === pickZone);
                if (!zone || zone.encounters.length === 0) return null;
                return (
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs font-medium uppercase">
                      Bosses (optional)
                    </p>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {zone.encounters.map((b) => (
                        <label
                          key={b.id}
                          className="flex items-center gap-1.5 text-xs"
                        >
                          <input
                            type="checkbox"
                            className="accent-primary h-3.5 w-3.5"
                            checked={pickBosses.includes(b.id)}
                            onChange={() => togglePickBoss(b.id)}
                          />
                          {b.name}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })()}
            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => setPickerOpen(false)}
              >
                Cancel
              </Button>
              <Button type="button" onClick={confirmPick} disabled={pickZone === null}>
                {pickBosses.length > 0
                  ? `Add ${pickBosses.length} boss${pickBosses.length === 1 ? "" : "es"}`
                  : "Add raid"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
