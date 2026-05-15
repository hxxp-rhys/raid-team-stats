"use client";

import { Suspense, use, useState } from "react";
import Link from "next/link";
import type { Route } from "next";

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { api } from "@/lib/trpc-client";
import { parseLayout } from "@/lib/widgets/types";
import { WidgetRender } from "@/components/widgets";
import { ExportCsvButton } from "./export-button";
import { ShareLinkButton } from "./share-button";

type Params = Promise<{ guildId: string; teamId: string; dashboardId: string }>;

export default function DashboardViewPage({ params }: { params: Params }) {
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
  const { guildId, teamId, dashboardId } = use(params);
  const q = api.dashboard.get.useQuery({ dashboardId });

  // Hook calls must run on every render — keep them ABOVE the early returns
  // even though `activeTabId` is unused on the pending/error branches.
  const [activeTabId, setActiveTabId] = useState<string>("overview");

  if (q.isPending) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-12">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
    );
  }
  if (q.error) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>Dashboard not found</CardTitle>
            <CardDescription>{q.error.message}</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }
  const dashboard = q.data;
  const layout = parseLayout(dashboard.layout);
  const totalWidgets = layout.tabs.reduce((sum, t) => sum + t.widgets.length, 0);
  const activeTab =
    layout.tabs.find((t) => t.id === activeTabId) ?? layout.tabs[0];

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-12">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <Link
            href={`/guild/${guildId}/team/${teamId}/dashboard` as Route}
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            ← Dashboards
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {dashboard.name}
          </h1>
          <p className="text-muted-foreground text-sm">
            {dashboard.visibility} · {totalWidgets} widget
            {totalWidgets === 1 ? "" : "s"} · {layout.tabs.length} tab
            {layout.tabs.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-start gap-2">
            <ShareLinkButton dashboardId={dashboardId} />
            <ExportCsvButton dashboardId={dashboardId} />
            <Link
              href={
                `/guild/${guildId}/team/${teamId}/dashboard/${dashboardId}/edit` as Route
              }
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Edit
            </Link>
          </div>
        </div>
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
                  {t.name}{" "}
                  <span className="text-muted-foreground text-xs">
                    ({t.widgets.length})
                  </span>
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
            <CardDescription>
              Add widgets from the edit page to start tracking team stats.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (activeTab?.widgets.length ?? 0) === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>This tab is empty</CardTitle>
            <CardDescription>
              Switch tabs above, or open the editor to add widgets here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {activeTab?.widgets.map((w) => (
            <WidgetRender key={w.id} instance={w} raidTeamId={teamId} />
          ))}
        </div>
      )}
    </main>
  );
}
