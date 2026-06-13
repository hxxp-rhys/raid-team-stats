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
