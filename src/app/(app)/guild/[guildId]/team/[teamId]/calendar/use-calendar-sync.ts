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

/** A raid the delete handler needs to identify (one-off vs recurring series). */
type DeletableEvent = { id: string; seriesId: string | null };

/**
 * Leader-only delete for a calendar raid. Branches on `seriesId`: a one-off
 * goes through `deleteEvent` (the server rejects series occurrences); a
 * recurring raid ends the WHOLE series via `endSeries` (deactivates it so the
 * materializer stops and clears future occurrences from the Month view).
 * Confirms first (series wording when recurring), then invalidates the calendar
 * queries — `eventsInRange` + `eventDetail`, plus `listSeries` for a series —
 * so every open surface drops the removed raid even before the sync poll fires.
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

  const confirmAndDelete = (event: DeletableEvent) => {
    if (event.seriesId) {
      if (
        window.confirm(
          "Delete the ENTIRE recurring series? This stops the schedule and removes its future occurrences. Past raids are untouched.",
        )
      ) {
        endSeries.mutate({ seriesId: event.seriesId });
      }
    } else if (window.confirm("Delete this raid? This can't be undone.")) {
      deleteEvent.mutate({ eventId: event.id });
    }
  };

  return { confirmAndDelete, isPending };
}
