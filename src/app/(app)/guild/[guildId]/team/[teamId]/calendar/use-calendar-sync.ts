"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/trpc-client";

/**
 * Live-sync for the calendar. Polls a cheap "pulse" (the team's max sync-outbox
 * id, a stable query key) every few seconds while the tab is focused; whenever
 * that id grows — meaning the website's source of truth advanced (this user,
 * another tab, a leader, or later Discord / in-game) — it invalidates the
 * calendar queries so every open surface re-renders within a few seconds.
 *
 * This is the short-poll transport (Phase 0). The SSE upgrade (Phase 2.5)
 * replaces the poll with a stream on the same outbox-id contract; callers don't
 * change.
 */
export function useCalendarSync(raidTeamId: string): void {
  const utils = api.useUtils();
  const lastSeen = useRef<bigint | null>(null);
  const [intervalMs, setIntervalMs] = useState(4000);

  useEffect(() => {
    const onVis = () => setIntervalMs(document.hidden ? 30000 : 4000);
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const pulse = api.calendar.pulse.useQuery(
    { raidTeamId },
    { refetchInterval: intervalMs, refetchOnWindowFocus: true },
  );

  useEffect(() => {
    if (!pulse.data) return;
    let id: bigint;
    try {
      id = BigInt(pulse.data.maxId);
    } catch {
      return;
    }
    if (lastSeen.current === null) {
      lastSeen.current = id;
      return; // first read = baseline, nothing to refetch
    }
    if (id > lastSeen.current) {
      lastSeen.current = id;
      void utils.calendar.eventsInRange.invalidate({ raidTeamId });
      void utils.calendar.eventDetail.invalidate();
      void utils.calendar.attendanceLedger.invalidate({ raidTeamId });
    }
  }, [pulse.data, raidTeamId, utils]);
}

/**
 * A raid the delete handler needs to identify (one-off vs recurring series).
 * `startsAt` is the clicked occurrence's start instant — for a recurring raid it
 * lets the server include THIS occurrence in the delete even when it's today /
 * in progress / just-passed (the whole point of the "delete from here" fix).
 */
type DeletableEvent = { id: string; seriesId: string | null; startsAt: Date };

/**
 * Leader-only delete for a calendar raid. Branches on `seriesId`: a one-off
 * goes through `deleteEvent` (the server rejects series occurrences); a
 * recurring raid HARD-deletes the clicked occurrence + everything upcoming via
 * `endSeries({ hardDelete: true, fromStartsAt })` — deactivating the series so
 * the materializer stops AND removing the clicked occurrence (even if it's
 * today / in progress / just-passed) plus every later occurrence (signups,
 * pins, locks and all) so the raid leaves BOTH the Agenda and Month views
 * entirely. Earlier past raids / attendance history are untouched. This is the
 * deliberate difference from the series manager's "End series", which omits the
 * flag (and the `fromStartsAt` floor) and keeps its cancel-signed-up behavior.
 *
 * Confirms first (series wording when recurring), then on success invalidates
 * the calendar queries — `eventsInRange` + `eventDetail`, plus `listSeries` for
 * a series — so every open surface drops the removed raid even before the sync
 * poll fires. On failure it exposes `error` (a server throw used to be silent —
 * "nothing happens") so the delete buttons can surface why it didn't delete.
 */
export function useDeleteRaid(raidTeamId: string, onDeleted?: () => void) {
  const utils = api.useUtils();
  const invalidate = async (wasSeries: boolean) => {
    await Promise.all([
      utils.calendar.eventsInRange.invalidate({ raidTeamId }),
      utils.calendar.eventDetail.invalidate(),
      ...(wasSeries ? [utils.calendar.listSeries.invalidate({ raidTeamId })] : []),
    ]);
    onDeleted?.();
  };
  const deleteEvent = api.calendar.deleteEvent.useMutation({
    onSuccess: () => void invalidate(false),
  });
  const endSeries = api.calendar.endSeries.useMutation({
    onSuccess: () => void invalidate(true),
  });

  const isPending = deleteEvent.isPending || endSeries.isPending;
  // Surface whichever delete path last threw so the button can show it. Both
  // mutations are mutually exclusive per click, so at most one carries an error.
  const error = deleteEvent.error?.message ?? endSeries.error?.message ?? null;

  const confirmAndDelete = (event: DeletableEvent) => {
    // Clear any prior error so a fresh attempt doesn't show a stale message.
    deleteEvent.reset();
    endSeries.reset();
    if (event.seriesId) {
      if (
        window.confirm(
          "Delete this recurring raid? This removes this occurrence and all upcoming ones from the calendar and stops the schedule. Earlier past raids stay for attendance history. This can't be undone.",
        )
      ) {
        endSeries.mutate({
          seriesId: event.seriesId,
          hardDelete: true,
          fromStartsAt: event.startsAt,
        });
      }
    } else if (window.confirm("Delete this raid? This can't be undone.")) {
      deleteEvent.mutate({ eventId: event.id });
    }
  };

  return { confirmAndDelete, isPending, error };
}
