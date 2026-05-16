"use client";

import { Suspense, use } from "react";

import { ControlPanel } from "./control-panel";

type Params = Promise<{ guildId: string; teamId: string }>;

/**
 * Team detail page. Renders the Dashboard Control Panel — sidebar +
 * tab-bar + widget grid + lightbox modals — for the active raid team.
 *
 * Wraps the inner `use(params)` consumer in Suspense per Next 16
 * cacheComponents: request-time params resolution must sit inside a
 * Suspense boundary so the static-shell prerender can produce HTML.
 */
export default function TeamPage({ params }: { params: Params }) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-7xl px-4 py-12">
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
  return <ControlPanel guildId={guildId} teamId={teamId} />;
}
