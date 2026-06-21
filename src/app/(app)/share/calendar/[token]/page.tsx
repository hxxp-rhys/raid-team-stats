"use client";

import { Suspense, use, useMemo, useState } from "react";

import { api } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
import { localDateInTz, zonedWallClockToUtc } from "@/lib/calendar/time";
import { leadingZoneIds, type RaidTargetItem } from "@/lib/calendar/raid-target";

type Params = Promise<{ token: string }>;

/**
 * Public, READ-ONLY view of a team calendar opened via a share link. Fed only
 * by the token-authorized `calendar.shareMeta` / `calendar.shareEvents`
 * procedures (no per-user state, no signup controls) — deliberately separate
 * from the authed CalendarPanel so it can never reach a member-only query.
 */

const DIFF_COLOR: Record<string, string> = {
  Mythic: "border-l-orange-500",
  Heroic: "border-l-purple-500",
  Normal: "border-l-sky-500",
  LFR: "border-l-zinc-500",
};

// WoW NA weekly reset (Tue 11:00 ET) — mirrors CalendarPanel's agenda bucketing.
const RESET_TZ = "America/New_York";
const RESET_TIME = "11:00";

function addDaysStr(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

function nextWeeklyReset(now: Date): Date {
  const todayET = localDateInTz(now, RESET_TZ);
  const [y, m, d] = todayET.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  let dateStr = addDaysStr(todayET, (2 - dow + 7) % 7);
  let reset = zonedWallClockToUtc(dateStr, RESET_TIME, RESET_TZ);
  if (reset.getTime() <= now.getTime()) {
    dateStr = addDaysStr(dateStr, 7);
    reset = zonedWallClockToUtc(dateStr, RESET_TIME, RESET_TZ);
  }
  return reset;
}

type ShareEvent = {
  id: string;
  title: string;
  difficulty: string;
  raidSize: number | null;
  startsAt: Date | string;
  status: string;
  seriesId: string | null;
  targetOrder: RaidTargetItem[];
  targetZoneIds: number[];
  present: number;
  responded: number;
};

export default function CalendarSharePage({ params }: { params: Params }) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-5xl px-4 py-8">
          <p className="text-muted-foreground text-sm">Loading…</p>
        </main>
      }
    >
      <Inner params={params} />
    </Suspense>
  );
}

function Inner({ params }: { params: Params }) {
  const { token } = use(params);
  const meta = api.calendar.shareMeta.useQuery({ token });
  // null = follow the link's default view; a click pins the viewer's choice.
  const [view, setView] = useState<"agenda" | "month" | null>(null);
  const zoneArt = useMemo(() => {
    const map = new Map<number, string>();
    for (const z of meta.data?.zones ?? []) {
      if (z.imageUrl) map.set(z.blizzardInstanceId, z.imageUrl);
    }
    return map;
  }, [meta.data]);

  if (meta.isPending) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
    );
  }
  if (meta.error || !meta.data) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="border-border bg-card rounded-lg border p-6">
          <h1 className="text-lg font-semibold">Calendar unavailable</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {meta.error?.message ??
              "This share link is invalid, has expired, or the calendar is no longer public."}
          </p>
        </div>
      </main>
    );
  }

  const m = meta.data;
  const activeView = view ?? m.view;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">{m.teamName}</h1>
        <p className="text-muted-foreground text-sm">Raid calendar · shared (read-only)</p>
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
                activeView === v
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <span className="text-muted-foreground text-xs">
          times in {m.timezone}
          {m.expiresAt
            ? ` · link expires ${new Date(m.expiresAt).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}`
            : ""}
        </span>
      </div>

      {activeView === "agenda" ? (
        <AgendaView token={token} />
      ) : (
        <MonthView token={token} zoneArt={zoneArt} />
      )}
    </main>
  );
}

function AgendaRow({ e }: { e: ShareEvent }) {
  return (
    <li
      className={cn(
        "border-border bg-card rounded-lg border border-l-4 p-3",
        DIFF_COLOR[e.difficulty] ?? "border-l-border",
        e.status === "CANCELLED" && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className={cn("font-medium", e.status === "CANCELLED" && "line-through")}>
            {e.title}
            {e.seriesId && (
              <span className="text-muted-foreground" title="Recurring">
                {" "}
                ↻
              </span>
            )}
            {e.status === "CANCELLED" && (
              <span className="text-destructive text-xs"> · cancelled</span>
            )}
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
        </div>
        <span className="text-muted-foreground text-xs tabular-nums">
          {e.present} in · {e.responded} responded
        </span>
      </div>
    </li>
  );
}

function AgendaSection({ title, events }: { title: string; events: ShareEvent[] }) {
  if (events.length === 0) return null;
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <span className="text-muted-foreground text-xs">
          {events.length} raid{events.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="space-y-2">
        {events.map((e) => (
          <AgendaRow key={e.id} e={e} />
        ))}
      </ul>
    </section>
  );
}

function AgendaView({ token }: { token: string }) {
  const from = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const to = useMemo(() => new Date(from.getTime() + 35 * 86_400_000), [from]);
  const resetMs = useMemo(() => nextWeeklyReset(new Date()).getTime(), []);
  const q = api.calendar.shareEvents.useQuery({ token, from, to });

  if (q.isPending) return <p className="text-muted-foreground text-sm">Loading…</p>;
  if (q.error) return <p className="text-destructive text-sm">{q.error.message}</p>;
  if (q.data.events.length === 0) {
    return (
      <p className="text-muted-foreground py-12 text-center text-sm">
        No upcoming raids scheduled.
      </p>
    );
  }

  const events = q.data.events as ShareEvent[];
  const WEEK_MS = 7 * 86_400_000;
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
      <AgendaSection title="This week" events={thisWeek} />
      <AgendaSection title="Upcoming" events={upcoming} />
    </div>
  );
}

function MonthView({
  token,
  zoneArt,
}: {
  token: string;
  zoneArt: Map<number, string>;
}) {
  const [monthStart, setMonthStart] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const cells = useMemo(() => {
    const y = monthStart.getFullYear();
    const mo = monthStart.getMonth();
    const first = new Date(y, mo, 1);
    const daysInMonth = new Date(y, mo + 1, 0).getDate();
    const weeks = Math.ceil((first.getDay() + daysInMonth) / 7);
    const cellCount = weeks * 7;
    const gridStart = new Date(y, mo, 1 - first.getDay());
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
  const gridEnd = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);

  const q = api.calendar.shareEvents.useQuery({ token, from: gridStart, to: gridEnd });

  const byDay = useMemo(() => {
    const map = new Map<string, ShareEvent[]>();
    for (const e of q.data?.events ?? []) {
      const key = new Date(e.startsAt).toLocaleDateString("en-CA");
      const arr = map.get(key) ?? [];
      arr.push(e as ShareEvent);
      map.set(key, arr);
    }
    return map;
  }, [q.data]);

  const todayKey = new Date().toLocaleDateString("en-CA");

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          className="border-border hover:bg-muted rounded-md border px-2 py-1 text-sm"
          onClick={() =>
            setMonthStart(new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1))
          }
        >
          ←
        </button>
        <p className="text-sm font-medium">
          {monthStart.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </p>
        <button
          type="button"
          className="border-border hover:bg-muted rounded-md border px-2 py-1 text-sm"
          onClick={() =>
            setMonthStart(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1))
          }
        >
          →
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-xs">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="text-muted-foreground pb-1 text-center font-medium">
            {d}
          </div>
        ))}
        {cells.map((day) => {
          const key = day.toLocaleDateString("en-CA");
          const inMonth = day.getMonth() === monthStart.getMonth();
          const events = byDay.get(key) ?? [];
          const tiles: string[] = [];
          for (const e of events) {
            const zoneIds =
              e.targetOrder.length > 0 ? leadingZoneIds(e.targetOrder) : e.targetZoneIds;
            for (const zid of zoneIds) {
              const url = zoneArt.get(zid);
              if (url && !tiles.includes(url) && tiles.length < 2) tiles.push(url);
            }
            if (tiles.length >= 2) break;
          }
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
                <div
                  aria-hidden
                  className="from-background/60 absolute inset-0 bg-gradient-to-t to-transparent"
                />
              )}

              <div className="relative z-10 flex h-full flex-col">
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
                    <div
                      key={e.id}
                      className={cn(
                        "block w-full rounded border-l-2 bg-background/85 px-1 py-0.5 text-left text-[10px]",
                        DIFF_COLOR[e.difficulty] ?? "border-l-border",
                        e.status === "CANCELLED" && "line-through opacity-60",
                      )}
                      title={e.title}
                    >
                      <span className="block truncate font-medium">{e.title}</span>
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
                    </div>
                  ))}
                  {overflow > 0 && (
                    <p className="text-muted-foreground px-1 text-[10px]">+{overflow} more</p>
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
