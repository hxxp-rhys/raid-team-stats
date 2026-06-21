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
import { CalendarShareModal } from "./calendar-share-modal";
import { STATE_META, StatusControl } from "./parts";
import type { AttendanceState } from "@/lib/calendar/roster";
import { localDateInTz, zonedWallClockToUtc } from "@/lib/calendar/time";
import { leadingZoneIds, type RaidTargetItem } from "@/lib/calendar/raid-target";

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
  const [shareOpen, setShareOpen] = useState(false);

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
          href={`/guild/${guildId}/team/${teamId}` as Route}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          ← Dashboard
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
        <div className="flex items-center gap-2">
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
          {canManage && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setShareOpen(true)}
              title={`Share the ${view} view`}
              aria-label="Share calendar"
            >
              ↗ Share
            </Button>
          )}
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
        <AgendaView teamId={teamId} onOpen={setDetailId} canManage={canManage} />
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
      <CalendarShareModal
        raidTeamId={teamId}
        view={view}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
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

/** Leader-only "Post to Discord" — renders only when the team is connected. */
function PostToDiscordButton({
  eventId,
  raidTeamId,
}: {
  eventId: string;
  raidTeamId: string;
}) {
  const status = api.discord.status.useQuery();
  const integ = api.discord.getIntegration.useQuery(
    { raidTeamId },
    { enabled: status.data?.enabled === true },
  );
  const post = api.discord.postEvent.useMutation();
  if (status.data?.enabled !== true || !integ.data?.integration) return null;
  return (
    <button
      type="button"
      onClick={() => post.mutate({ eventId })}
      disabled={post.isPending}
      title={post.error?.message ?? "Post this raid's signup board to Discord"}
      className={cn(
        "border-border hover:bg-muted inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors disabled:opacity-50",
        post.isError && "border-destructive text-destructive",
      )}
    >
      {post.isPending ? "Posting…" : post.isSuccess ? "Posted ✓" : "↗ Post to Discord"}
    </button>
  );
}

function AgendaRow({
  e,
  onOpen,
  canManage,
  teamId,
}: {
  e: AgendaEvent;
  onOpen: (id: string) => void;
  canManage: boolean;
  teamId: string;
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
        <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
          <StatusControl
            eventId={e.id}
            current={(e.myState as AttendanceState) ?? null}
            currentEta={e.myEta}
            size="sm"
          />
          {canManage && <PostToDiscordButton eventId={e.id} raidTeamId={teamId} />}
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
  canManage,
  teamId,
}: {
  title: string;
  hint?: string;
  events: AgendaEvent[];
  onOpen: (id: string) => void;
  canManage: boolean;
  teamId: string;
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
          <AgendaRow key={e.id} e={e} onOpen={onOpen} canManage={canManage} teamId={teamId} />
        ))}
      </ul>
    </section>
  );
}

function AgendaView({
  teamId,
  onOpen,
  canManage,
}: {
  teamId: string;
  onOpen: (id: string) => void;
  canManage: boolean;
}) {
  const from = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const to = useMemo(() => new Date(from.getTime() + 35 * 86400000), [from]);
  // Next weekly reset (Tue 11:00 ET). Lockout weeks are delimited by it; the
  // agenda shows just the soonest raid week + the one after — never a wall.
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

  // events come back sorted ascending by start. Bucket each into its lockout
  // week (0 = before the next reset, +1 per reset), anchor on the SOONEST
  // raid's week, and show only that week ("This week") + the next ("Upcoming").
  // Everything beyond those two weeks is intentionally dropped — no 10-raid wall.
  const events = q.data.events as AgendaEvent[];
  const WEEK_MS = 7 * 86400000;
  const weekOf = (t: number) => (t < resetMs ? 0 : Math.floor((t - resetMs) / WEEK_MS) + 1);
  const anchor = weekOf(new Date(events[0]!.startsAt).getTime());
  const thisWeek = events.filter(
    (e) => weekOf(new Date(e.startsAt).getTime()) === anchor,
  );
  const upcoming = events.filter(
    (e) => weekOf(new Date(e.startsAt).getTime()) === anchor + 1,
  );

  return (
    <div className="space-y-5">
      <AgendaSection title="This week" events={thisWeek} onOpen={onOpen} canManage={canManage} teamId={teamId} />
      <AgendaSection title="Upcoming" events={upcoming} onOpen={onOpen} canManage={canManage} teamId={teamId} />
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
        seriesId: string | null;
        myState: string | null;
        targetOrder: RaidTargetItem[];
        targetZoneIds: number[];
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
        seriesId: e.seriesId,
        myState: e.myState,
        targetOrder: e.targetOrder ?? [],
        targetZoneIds: e.targetZoneIds ?? [],
      });
      m.set(key, arr);
    }
    return m;
  }, [q.data]);

  // Zone → official tile art, for painting targeted days. Fetched once; an
  // empty/failed map just means no backgrounds (cells keep their difficulty
  // tint). Resolved client-side from the same `targetableZones` the lead picks.
  const zonesQ = api.calendar.targetableZones.useQuery({ raidTeamId: teamId });
  const zoneArt = useMemo(() => {
    const m = new Map<number, string>();
    for (const z of zonesQ.data?.zones ?? []) {
      if (z.imageUrl) m.set(z.blizzardInstanceId, z.imageUrl);
    }
    return m;
  }, [zonesQ.data]);

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
          // Distinct targeted-zone tiles for this day (across its events), max 2
          // — one zone fills the cell, two split it diagonally.
          const tiles: string[] = [];
          for (const e of events) {
            // First two ORDERED entries' raids drive the art (falling back to
            // the flat zone list for pre-targetOrder events).
            const zoneIds =
              e.targetOrder.length > 0 ? leadingZoneIds(e.targetOrder) : e.targetZoneIds;
            for (const zid of zoneIds) {
              const url = zoneArt.get(zid);
              if (url && !tiles.includes(url) && tiles.length < 2) tiles.push(url);
            }
            if (tiles.length >= 2) break;
          }
          // Small squares can't show every raid — show the first 3, then "+N".
          const shown = events.slice(0, 3);
          const overflow = events.length - shown.length;
          return (
            <div
              key={key}
              className={cn(
                "border-border relative aspect-square overflow-hidden rounded border p-1",
                key === todayKey && "ring-primary ring-1",
              )}
            >
              {/* Zone-art background layer (below content). A dark scrim keeps
                  text legible over the tile. */}
              {tiles.length === 1 && (
                <div
                  aria-hidden
                  className="absolute inset-0 bg-cover bg-center opacity-50"
                  style={{ backgroundImage: `url("${tiles[0]}")` }}
                />
              )}
              {tiles.length === 2 && (
                <>
                  <div
                    aria-hidden
                    className="absolute inset-0 bg-cover bg-center opacity-50"
                    style={{
                      backgroundImage: `url("${tiles[0]}")`,
                      clipPath: "polygon(0 0, 100% 0, 0 100%)",
                    }}
                  />
                  <div
                    aria-hidden
                    className="absolute inset-0 bg-cover bg-center opacity-50"
                    style={{
                      backgroundImage: `url("${tiles[1]}")`,
                      clipPath: "polygon(100% 0, 100% 100%, 0 100%)",
                    }}
                  />
                </>
              )}
              {tiles.length > 0 && (
                <div aria-hidden className="from-background/60 absolute inset-0 bg-gradient-to-t to-transparent" />
              )}

              <div className="relative z-10 flex h-full flex-col">
                {/* Current month vs adjacent distinguished by NUMBER COLOR only
                    (full opacity) — no cell fade. */}
                <div
                  className={cn(
                    "mb-0.5 shrink-0 text-right text-[10px]",
                    inMonth ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {day.getDate()}
                </div>
                <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
                  {shown.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => onOpen(e.id)}
                      className={cn(
                        "block w-full rounded border-l-2 bg-background/85 px-1 py-0.5 text-left text-[10px] hover:bg-muted",
                        DIFF_COLOR[e.difficulty] ?? "border-l-border",
                        e.status === "CANCELLED" && "line-through opacity-60",
                      )}
                      title={e.title}
                    >
                      {/* Two lines: title (with my-status glyph), then the time
                          plus a recurring marker when it belongs to a series. */}
                      <span className="block truncate font-medium">
                        {e.myState && (
                          <span aria-hidden>
                            {STATE_META[e.myState as AttendanceState]?.glyph}{" "}
                          </span>
                        )}
                        {e.title}
                      </span>
                      <span className="text-muted-foreground flex items-center gap-0.5">
                        {new Date(e.startsAt).toLocaleTimeString(undefined, {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                        {e.seriesId && (
                          <span aria-hidden title="Recurring">
                            ↻
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                  {overflow > 0 && (
                    <button
                      type="button"
                      onClick={() => onOpen(events[0]!.id)}
                      className="text-muted-foreground hover:text-foreground block w-full px-1 text-left text-[10px]"
                    >
                      +{overflow} more
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
