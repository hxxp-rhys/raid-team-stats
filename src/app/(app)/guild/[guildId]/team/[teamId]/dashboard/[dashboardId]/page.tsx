"use client";

import { Suspense, use } from "react";
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
            {dashboard.visibility} · {layout.widgets.length} widget
            {layout.widgets.length === 1 ? "" : "s"}
          </p>
        </div>
        <Link
          href={
            `/guild/${guildId}/team/${teamId}/dashboard/${dashboardId}/edit` as Route
          }
          className={buttonVariants({ size: "sm", variant: "outline" })}
        >
          Edit
        </Link>
      </header>

      {layout.widgets.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>This dashboard is empty</CardTitle>
            <CardDescription>
              Add widgets from the edit page to start tracking team stats.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {layout.widgets.map((w) => (
            <WidgetRender key={w.id} instance={w} raidTeamId={teamId} />
          ))}
        </div>
      )}
    </main>
  );
}
