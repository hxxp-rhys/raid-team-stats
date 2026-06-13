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
import { STATE_META, StatusControl } from "./parts";
import type { AttendanceState } from "@/lib/calendar/roster";

const DIFF_COLOR: Record<string, string> = {
  Mythic: "border-l-orange-500",
  Heroic: "border-l-purple-500",
  Normal: "border-l-sky-500",
  LFR: "border-l-zinc-500",
};

export function CalendarPanel({
  guildId,
  teamId,
}: {
  guildId: string;
  teamId: string;
}) {
  useCalendarSync(teamId);
  const team = api.raidTeam.get.useQuery({ raidTeamId: teamId });
  const meta = api.calendar.meta.useQuery({ raidTeamId: teamId });
  const [view, setView] = useState<"agenda" | "month">("agenda");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
        current={meta.data ? { timezone: meta.data.timezone, comp: meta.data.comp } : null}
      />
    </main>
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
  return (
    <ul className="space-y-2">
      {q.data.events.map((e) => (
        <li
          key={e.id}
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
      ))}
    </ul>
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

  // 6-week grid starting on the Sunday on/before the 1st. Cells are built with
  // CALENDAR arithmetic (new Date(y, m, d+i)), never fixed-24h ms addition —
  // a DST fall-back day is 25h, so ms math would collapse two days onto one
  // local date and shift every later cell's weekday by a column.
  const cells = useMemo(() => {
    const first = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1);
    const gridStart = new Date(
      first.getFullYear(),
      first.getMonth(),
      1 - first.getDay(),
    );
    return Array.from(
      { length: 42 },
      (_, i) =>
        new Date(
          gridStart.getFullYear(),
          gridStart.getMonth(),
          gridStart.getDate() + i,
        ),
    );
  }, [monthStart]);
  const gridStart = cells[0]!;
  const gridEnd = new Date(
    cells[41]!.getFullYear(),
    cells[41]!.getMonth(),
    cells[41]!.getDate() + 1,
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
                !inMonth && "opacity-40",
                key === todayKey && "ring-primary ring-1",
              )}
            >
              <div className="text-muted-foreground mb-0.5 text-right text-[10px]">{day.getDate()}</div>
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
