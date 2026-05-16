"use client";

import { Suspense, use, useState } from "react";

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/trpc-client";
import {
  DESKTOP_GRID_COLS,
  ROW_HEIGHT_PX,
  parseLayout,
  resolveDefaultTabId,
} from "@/lib/widgets/types";
import { WidgetCell } from "@/app/(app)/guild/[guildId]/team/[teamId]/widget-cell";

type Params = Promise<{ token: string }>;

/**
 * Public-by-URL dashboard view. Auth.js still gates the page — anonymous
 * visitors are bounced to /signin. After sign-in, the server-side
 * resolver verifies the token's signature AND that the caller is an
 * active guild member. Non-members get a generic "not found" message.
 *
 * Renders with the SAME grid + WidgetCell (read-only) the control panel
 * uses, so the shared layout is pixel-identical to what the editor saved.
 */
export default function ShareViewPage({ params }: { params: Params }) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-[1400px] px-4 py-8">
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
  const q = api.dashboard.getByShareToken.useQuery({ token });
  // Hooks must run on every render path — keep above early returns.
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  if (q.isPending) {
    return (
      <main className="mx-auto max-w-[1400px] px-4 py-8">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
    );
  }
  if (q.error) {
    return (
      <main className="mx-auto max-w-[1400px] px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Dashboard not available</CardTitle>
            <CardDescription>{q.error.message}</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  const { dashboard, expiresAt } = q.data;
  const layout = parseLayout(dashboard.layout);
  const totalWidgets = layout.tabs.reduce((s, t) => s + t.widgets.length, 0);
  const selectedTabId = activeTabId ?? resolveDefaultTabId(layout);
  const activeTab =
    layout.tabs.find((t) => t.id === selectedTabId) ?? layout.tabs[0];
  const expires = new Date(expiresAt);

  return (
    <main className="mx-auto max-w-[1400px] space-y-4 px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {dashboard.name}
        </h1>
        <p className="text-muted-foreground text-sm">
          Shared view · {totalWidgets} widget
          {totalWidgets === 1 ? "" : "s"} · expires{" "}
          {expires.toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        </p>
      </header>

      {layout.tabs.length > 1 && (
        <div className="border-b border-border" role="tablist">
          <div className="flex flex-wrap gap-1">
            {layout.tabs.map((t) => {
              const isActive = t.id === activeTab?.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveTabId(t.id)}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {totalWidgets === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>This dashboard is empty</CardTitle>
          </CardHeader>
        </Card>
      ) : (
        <div
          className="grid gap-2"
          style={{
            gridTemplateColumns: `repeat(${DESKTOP_GRID_COLS}, minmax(0, 1fr))`,
            gridAutoRows: `${ROW_HEIGHT_PX}px`,
            gridAutoFlow: "dense",
          }}
        >
          {activeTab?.widgets.map((w) => (
            <WidgetCell
              key={w.id}
              widget={w}
              raidTeamId={dashboard.raidTeamId}
              editing={false}
              isMobile={false}
            />
          ))}
        </div>
      )}
    </main>
  );
}
