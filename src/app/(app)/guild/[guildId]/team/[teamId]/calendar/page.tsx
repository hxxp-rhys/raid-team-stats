"use client";

import { Suspense, use } from "react";

import { CalendarPanel } from "./calendar-panel";

type Params = Promise<{ guildId: string; teamId: string }>;

/**
 * Per-team raid calendar + attendance. Sibling route to the team dashboard;
 * the same role gating (MEMBER read, CO_LEADER schedule, LEADER lock/cancel)
 * is re-enforced server-side on every calendar procedure.
 */
export default function CalendarPage({ params }: { params: Params }) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-5xl px-4 py-12">
          <p className="text-muted-foreground text-sm">Loading…</p>
        </main>
      }
    >
      <Inner params={params} />
    </Suspense>
  );
}

function Inner({ params }: { params: Params }) {
  const { guildId, teamId } = use(params);
  return <CalendarPanel guildId={guildId} teamId={teamId} />;
}
