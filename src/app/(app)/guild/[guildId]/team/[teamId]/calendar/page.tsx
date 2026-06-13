"use client";

import { Suspense, use } from "react";

import { CalendarPanel } from "./calendar-panel";

type Params = Promise<{ guildId: string; teamId: string }>;
type SearchParams = Promise<{ event?: string }>;

/**
 * Per-team raid calendar + attendance. Sibling route to the team dashboard;
 * the same role gating (MEMBER read, CO_LEADER schedule, LEADER lock/cancel)
 * is re-enforced server-side on every calendar procedure.
 */
export default function CalendarPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-5xl px-4 py-12">
          <p className="text-muted-foreground text-sm">Loading…</p>
        </main>
      }
    >
      <Inner params={params} searchParams={searchParams} />
    </Suspense>
  );
}

function Inner({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { guildId, teamId } = use(params);
  // Deep link from a reminder email: ?event=<id> opens that event on mount.
  const { event } = use(searchParams);
  return (
    <CalendarPanel
      guildId={guildId}
      teamId={teamId}
      initialEventId={event ?? null}
    />
  );
}
