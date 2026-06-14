"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";

import { api } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCalendarSync } from "./use-calendar-sync";
import { EventDetailModal } from "./event-detail-modal";
import { EventFormModal } from "./event-form-modal";
import { SettingsModal } from "./settings-modal";
import { SeriesManagerModal } from "./series-manager-modal";
import { STATE_META, StatusControl } from "./parts";
import type { AttendanceState } from "@/lib/calendar/roster";
import { localDateInTz, zonedWallClockToUtc } from "@/lib/calendar/time";

const DIFF_COLOR: Record<string, string> = {
  Mythic: "border-l-orange-500",
  Heroic: "border-l-purple-500",
  Normal: "border-l-sky-500",
  LFR: "border-l-zinc-500",
};

// WoW NA weekly lockout reset: Tuesday 11:00 America/New_York (15:00 UTC during
// EDT). Agenda groups raids by this boundary: those before the next reset are
// "This week" (the current lockout), the rest are "Upcoming".
const RESET_TZ = "America/New_York";
const RESET_TIME = "11:00";

function addDaysStr(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** The next Tuesday-11:00-Eastern reset instant strictly after `now`. */
function nextWeeklyReset(now: Date): Date {
  const todayET = localDateInTz(now, RESET_TZ);
  const [y, m, d] = todayET.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // Tue = 2
  let dateStr = addDaysStr(todayET, (2 - dow + 7) % 7);
  let reset = zonedWallClockToUtc(dateStr, RESET_TIME, RESET_TZ);
  if (reset.getTime() <= now.getTime()) {
    dateStr = addDaysStr(dateStr, 7);
    reset = zonedWallClockToUtc(dateStr, RESET_TIME, RESET_TZ);
  }
  return reset;
}

export function CalendarPanel({
  guildId,
  teamId,
  initialEventId = null,
}: {
  guildId: string;
  teamId: string;
  initialEventId?: string | null;
}) {
  useCalendarSync(teamId);
  const team = api.raidTeam.get.useQuery({ raidTeamId: teamId });
  const meta = api.calendar.meta.useQuery({ raidTeamId: teamId });
  const [view, setView] = useState<"agenda" | "month">("agenda");
  // Deep link from a reminder email: ?event=<id> opens that event on mount.
  const [detailId, setDetailId] = useState<string | null>(initialEventId);
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [seriesOpen, setSeriesOpen] = useState(false);

  const canManage = meta.data?.role === "CO_LEADER" || meta.data?.role === "LEADER";
  const canLead = meta.data?.role === "LEADER";

  const openCreate = () => {
    setEditId(null);
    setFormOpen(true);
  };
  const openEdit = (id: string) => {
    setDetailId(null);
    setEditId(id);
    setFormOpen(true);
  };

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-5">
        <Link
          href={"/guild" as Route}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          ← Guilds
        </Link>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {team.data?.name ?? "Raid team"}
            </h1>
            <p className="text-muted-foreground text-sm">Raid calendar</p>
          </div>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              href={`/guild/${guildId}/team/${teamId}` as Route}
              className="border-border bg-background hover:bg-muted inline-flex h-8 items-center rounded-md border px-3 font-medium"
            >
              Dashboard
            </Link>
            <span className="border-primary bg-muted inline-flex h-8 items-center rounded-md border px-3 font-medium">
              Calendar
            </span>
          </nav>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="border-border inline-flex rounded-md border p-0.5 text-sm">
          {(["agenda", "month"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "rounded px-3 py-1 font-medium capitalize transition-colors",
                view === v ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {meta.data && (
            <span className="text-muted-foreground text-xs">
              times in {meta.data.timezone}
            </span>
          )}
          {canManage && (
            <Button type="button" size="sm" variant="outline" onClick={() => setSeriesOpen(true)}>
              ↻ Recurring
            </Button>
          )}
          {canLead && (
            <Button type="button" size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
              Settings
            </Button>
          )}
          {canManage && (
            <Button type="button" size="sm" onClick={openCreate}>
              ＋ Schedule raid
            </Button>
          )}
        </div>
      </div>

      {view === "agenda" ? (
        <AgendaView teamId={teamId} onOpen={setDetailId} />
      ) : (
        <MonthView teamId={teamId} onOpen={setDetailId} />
      )}

      <EventDetailModal
        eventId={detailId}
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        canLead={canLead}
        onEdit={openEdit}
      />
      <EventFormModal
        raidTeamId={teamId}
        timezone={meta.data?.timezone ?? "UTC"}
        editEventId={editId}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={() => undefined}
      />
      <SettingsModal
        raidTeamId={teamId}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        current={
          meta.data
            ? {
                timezone: meta.data.timezone,
                comp: meta.data.comp,
                reminders: meta.data.reminders,
              }
            : null
        }
      />
      <SeriesManagerModal
        raidTeamId={teamId}
        timezone={meta.data?.timezone ?? "UTC"}
        canLead={canLead}
        open={seriesOpen}
        onClose={() => setSeriesOpen(false)}
      />
    </main>
  );
}

type AgendaEvent = {
  id: string;
  title: string;
  difficulty: string;
  raidSize: number | null;
  startsAt: Date | string;
  status: string;
  seriesId: string | null;
  present: number;
  responded: number;
  myState: string | null;
  myEta: number | null;
};

function AgendaRow({
  e,
  onOpen,
}: {
  e: AgendaEvent;
  onOpen: (id: string) => void;
}) {
  return (
    <li
      className={cn(
        "border-border bg-card rounded-lg border border-l-4 p-3",
        DIFF_COLOR[e.difficulty] ?? "border-l-border",
        e.status === "CANCELLED" && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button type="button" className="text-left" onClick={() => onOpen(e.id)}>
          <p className={cn("font-medium", e.status === "CANCELLED" && "line-through")}>
            {e.title}
            {e.seriesId && (
              <span className="text-muted-foreground" title="Recurring"> ↻</span>
            )}
            {e.status === "LOCKED" && <span className="text-amber-500"> 🔒</span>}
            {e.status === "CANCELLED" && <span className="text-destructive text-xs"> · cancelled</span>}
          </p>
          <p className="text-muted-foreground text-xs">
            {new Date(e.startsAt).toLocaleString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
            {" · "}
            {e.difficulty}
            {e.raidSize ? ` · ${e.raidSize}` : ""}
          </p>
        </button>
        <span className="text-muted-foreground text-xs tabular-nums">
          {e.present} in · {e.responded} responded
        </span>
      </div>
      {e.status !== "CANCELLED" && (
        <div className="mt-2">
          <StatusControl
            eventId={e.id}
            current={(e.myState as AttendanceState) ?? null}
            currentEta={e.myEta}
            size="sm"
          />
        </div>
      )}
    </li>
  );
}

function AgendaSection({
  title,
  hint,
  events,
  onOpen,
}: {
  title: string;
  hint?: string;
  events: AgendaEvent[];
  onOpen: (id: string) => void;
}) {
  if (events.length === 0) return null;
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <span className="text-muted-foreground text-xs">
          {hint ?? `${events.length} raid${events.length === 1 ? "" : "s"}`}
        </span>
      </div>
      <ul className="space-y-2">
        {events.map((e) => (
          <AgendaRow key={e.id} e={e} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

function AgendaView({
  teamId,
  onOpen,
}: {
  teamId: string;
  onOpen: (id: string) => void;
}) {
  const from = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const to = useMemo(() => new Date(from.getTime() + 35 * 86400000), [from]);
  // Split on the next weekly reset (Tue 11:00 ET): raids before it belong to
  // the current lockout ("This week"); raids at/after it are "Upcoming".
  const resetMs = useMemo(() => nextWeeklyReset(new Date()).getTime(), []);
  const q = api.calendar.eventsInRange.useQuery({ raidTeamId: teamId, from, to });

  if (q.isPending) return <p className="text-muted-foreground text-sm">Loading…</p>;
  if (q.error) return <p className="text-destructive text-sm">{q.error.message}</p>;
  if (q.data.events.length === 0) {
    return (
      <p className="text-muted-foreground py-12 text-center text-sm">
        No upcoming raids scheduled.
      </p>
    );
  }

  const events = q.data.events as AgendaEvent[];
  const thisWeek = events.filter((e) => new Date(e.startsAt).getTime() < resetMs);
  const upcoming = events.filter((e) => new Date(e.startsAt).getTime() >= resetMs);

  return (
    <div className="space-y-5">
      <AgendaSection title="This week" events={thisWeek} onOpen={onOpen} />
      <AgendaSection title="Upcoming" events={upcoming} onOpen={onOpen} />
    </div>
  );
}

function MonthView({
  teamId,
  onOpen,
}: {
  teamId: string;
  onOpen: (id: string) => void;
}) {
  const [monthStart, setMonthStart] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  // Week grid starting on the Sunday on/before the 1st. Cells are built with
  // CALENDAR arithmetic (new Date(y, m, d+i)), never fixed-24h ms addition —
  // a DST fall-back day is 25h, so ms math would collapse two days onto one
  // local date and shift every later cell's weekday by a column.
  //
  // The grid renders ONLY the weeks this month actually spans (4, 5, or 6) —
  // not a fixed 6 — so a month that ends mid-grid doesn't trail an entire row
  // of next-month days (which, dimmed, read as the calendar "fading out").
  const cells = useMemo(() => {
    const y = monthStart.getFullYear();
    const m = monthStart.getMonth();
    const first = new Date(y, m, 1);
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const weeks = Math.ceil((first.getDay() + daysInMonth) / 7);
    const cellCount = weeks * 7;
    const gridStart = new Date(y, m, 1 - first.getDay());
    return Array.from(
      { length: cellCount },
      (_, i) =>
        new Date(
          gridStart.getFullYear(),
          gridStart.getMonth(),
          gridStart.getDate() + i,
        ),
    );
  }, [monthStart]);
  const gridStart = cells[0]!;
  const last = cells[cells.length - 1]!;
  const gridEnd = new Date(
    last.getFullYear(),
    last.getMonth(),
    last.getDate() + 1,
  );

  const q = api.calendar.eventsInRange.useQuery({
    raidTeamId: teamId,
    from: gridStart,
    to: gridEnd,
  });

  const byDay = useMemo(() => {
    const m = new Map<
      string,
      {
        id: string;
        title: string;
        difficulty: string;
        startsAt: Date;
        status: string;
        myState: string | null;
      }[]
    >();
    for (const e of q.data?.events ?? []) {
      const key = new Date(e.startsAt).toLocaleDateString("en-CA");
      const arr = m.get(key) ?? [];
      arr.push({
        id: e.id,
        title: e.title,
        difficulty: e.difficulty,
        startsAt: new Date(e.startsAt),
        status: e.status,
        myState: e.myState,
      });
      m.set(key, arr);
    }
    return m;
  }, [q.data]);

  const todayKey = new Date().toLocaleDateString("en-CA");

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          className="border-border hover:bg-muted rounded-md border px-2 py-1 text-sm"
          onClick={() => setMonthStart(new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1))}
        >
          ←
        </button>
        <p className="text-sm font-medium">
          {monthStart.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </p>
        <button
          type="button"
          className="border-border hover:bg-muted rounded-md border px-2 py-1 text-sm"
          onClick={() => setMonthStart(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1))}
        >
          →
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-xs">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="text-muted-foreground pb-1 text-center font-medium">{d}</div>
        ))}
        {cells.map((day) => {
          const key = day.toLocaleDateString("en-CA");
          const inMonth = day.getMonth() === monthStart.getMonth();
          const events = byDay.get(key) ?? [];
          return (
            <div
              key={key}
              className={cn(
                "border-border min-h-16 rounded border p-1",
                key === todayKey && "ring-primary ring-1",
              )}
            >
              {/* Current month vs adjacent distinguished by NUMBER COLOR only
                  (full opacity) — no cell fade. */}
              <div
                className={cn(
                  "mb-0.5 text-right text-[10px]",
                  inMonth ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {day.getDate()}
              </div>
              <div className="space-y-0.5">
                {events.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => onOpen(e.id)}
                    className={cn(
                      "block w-full truncate rounded border-l-2 bg-muted/50 px-1 py-0.5 text-left text-[10px] hover:bg-muted",
                      DIFF_COLOR[e.difficulty] ?? "border-l-border",
                      e.status === "CANCELLED" && "line-through opacity-60",
                    )}
                    title={e.title}
                  >
                    {e.myState && <span aria-hidden>{STATE_META[e.myState as AttendanceState]?.glyph} </span>}
                    {new Date(e.startsAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} {e.title}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
