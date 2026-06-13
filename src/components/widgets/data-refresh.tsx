"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetError, WidgetLoading } from "./shell";

// Stable identity for the disabled-query placeholder so the query key
// doesn't churn while no refresh is in flight.
const EPOCH = new Date(0);

type Schedule =
  | { kind: "interval"; hours: number }
  | { kind: "weekly"; dayOfWeek: number; hour: number; minute: number }
  | null;

/**
 * Compute the next scheduled refresh time from the schedule + last refresh.
 *   interval — lastRefreshAt + N hours (or "now" if never refreshed)
 *   weekly   — the next future occurrence of the day/time
 * Returns null when there's no schedule.
 */
function nextRefreshAt(
  schedule: Schedule,
  lastRefreshAt: Date | null,
  now: Date,
): Date | null {
  if (!schedule) return null;
  if (schedule.kind === "interval") {
    const base = lastRefreshAt ?? now;
    return new Date(base.getTime() + schedule.hours * 3_600_000);
  }
  // weekly: walk forward from now to the next matching day/time.
  const d = new Date(now);
  d.setSeconds(0, 0);
  for (let i = 0; i < 8; i++) {
    if (
      d.getDay() === schedule.dayOfWeek &&
      (d.getHours() > schedule.hour ||
        (d.getHours() === schedule.hour && d.getMinutes() >= schedule.minute))
    ) {
      // today's slot already passed → advance a week
      d.setDate(d.getDate() + (i === 0 ? 7 : 0));
    }
    if (d.getDay() === schedule.dayOfWeek) {
      const candidate = new Date(d);
      candidate.setHours(schedule.hour, schedule.minute, 0, 0);
      if (candidate.getTime() > now.getTime()) return candidate;
    }
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
  }
  return null;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "due now";
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Dashboard widget: a one-click refresh of the raid team's data. Presence
 * of this widget on a dashboard is what grants refresh access — the server
 * still enforces team membership. The recurring schedule is configured from
 * the dashboard editor's Auto-refresh menu, not here; if a schedule exists
 * the widget shows a live countdown to the next run.
 */
export function DataRefreshWidget({ raidTeamId }: { raidTeamId: string }) {
  const settings = api.raidTeam.refreshSettings.useQuery({ raidTeamId });
  const utils = api.useUtils();
  const { status: sessionStatus } = useSession();
  const isAuthed = sessionStatus === "authenticated";

  // Baseline + total for the in-flight refresh. Set only on a successful
  // trigger that actually enqueued work; cleared on no-op/rate-limit.
  const [progress, setProgress] = useState<{
    since: Date;
    total: number;
  } | null>(null);

  const trigger = api.raidTeam.triggerTeamRefresh.useMutation({
    onSuccess: (data) => {
      void utils.raidTeam.refreshSettings.invalidate({ raidTeamId });
      setProgress(
        data.ok && data.enqueued > 0
          ? { since: data.at, total: data.enqueued }
          : null,
      );
    },
  });

  // Poll synced/total while a refresh is in flight; stop once complete.
  const sync = api.raidTeam.syncProgress.useQuery(
    { raidTeamId, since: progress?.since ?? EPOCH },
    {
      enabled: progress != null,
      refetchInterval: (query) => {
        const d = query.state.data;
        return d && d.synced >= d.total ? false : 2000;
      },
    },
  );
  const syncedCount = progress
    ? Math.min(sync.data?.synced ?? 0, progress.total)
    : 0;

  // Tick every 30s so the countdown stays live without hammering the server.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (settings.isPending) {
    return (
      <WidgetShell title="Data refresh">
        <WidgetLoading />
      </WidgetShell>
    );
  }
  if (settings.error) {
    return (
      <WidgetShell title="Data refresh">
        <WidgetError message={settings.error.message} />
      </WidgetShell>
    );
  }
  const s = settings.data!;
  const schedule = (s.refreshSchedule as Schedule) ?? null;
  const lastRefreshAt = s.lastRefreshAt ? new Date(s.lastRefreshAt) : null;
  const next = nextRefreshAt(schedule, lastRefreshAt, now);

  return (
    <WidgetShell
      title="Data refresh"
      description="Refresh to sync raid team data."
    >
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-muted-foreground">Last refresh</span>
          <span className="font-medium">
            {lastRefreshAt ? lastRefreshAt.toLocaleString() : "—"}
          </span>
        </div>

        {schedule && next && (
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-muted-foreground">Next auto-refresh</span>
            <span
              className="font-medium"
              title={next.toLocaleString()}
            >
              in {formatCountdown(next.getTime() - now.getTime())}
            </span>
          </div>
        )}

        {/* Anonymous public-share viewers can SEE the schedule but never
            trigger (the mutation is session-gated server-side anyway —
            hiding the button just spares them a guaranteed error). */}
        {isAuthed && (
          <div className="pt-1">
            <Button
              size="sm"
              disabled={trigger.isPending}
              onClick={() => trigger.mutate({ raidTeamId })}
            >
              {trigger.isPending ? "Queueing…" : "Refresh now"}
            </Button>
          </div>
        )}

        {trigger.data?.ok && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">
              Queued {trigger.data.enqueued} character{" "}
              {trigger.data.enqueued === 1 ? "sync" : "syncs"}.
            </span>
            {progress && (
              <span
                className="text-foreground font-medium tabular-nums"
                aria-live="polite"
              >
                Sync completion: {syncedCount}/{progress.total}
              </span>
            )}
          </div>
        )}
        {trigger.data && trigger.data.ok === false && (
          <p className="text-muted-foreground text-xs">
            Nothing to refresh
            {trigger.data.reason === "no_members"
              ? " — no active members."
              : "."}
          </p>
        )}
        {trigger.error && (
          <p className="text-destructive text-xs" role="alert">
            {trigger.error.message}
          </p>
        )}
      </div>
    </WidgetShell>
  );
}
