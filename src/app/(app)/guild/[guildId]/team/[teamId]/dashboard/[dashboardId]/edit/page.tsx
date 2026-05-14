"use client";

import { Suspense, use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/trpc-client";
import {
  parseLayout,
  WIDGET_META,
  WIDGET_TYPES,
  type DashboardLayout,
  type WidgetInstance,
  type WidgetType,
} from "@/lib/widgets/types";
import { WidgetRender } from "@/components/widgets";

type Params = Promise<{ guildId: string; teamId: string; dashboardId: string }>;

export default function DashboardEditPage({ params }: { params: Params }) {
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

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `w-${Date.now()}-${Math.random()}`;

function Inner({ params }: { params: Params }) {
  const { guildId, teamId, dashboardId } = use(params);
  const router = useRouter();

  const q = api.dashboard.get.useQuery({ dashboardId });
  const update = api.dashboard.updateLayout.useMutation();
  const remove = api.dashboard.delete.useMutation({
    onSuccess: () =>
      router.push(`/guild/${guildId}/team/${teamId}/dashboard` as Route),
  });

  const [layout, setLayout] = useState<DashboardLayout>({ widgets: [] });
  const [dirty, setDirty] = useState(false);
  // Track which server snapshot we last initialised from; updating state
  // *during render* (not in an effect) is the recommended React 19 pattern
  // for derived-from-fetched-data state.
  const [initFromId, setInitFromId] = useState<string | null>(null);
  if (q.data && initFromId !== q.data.id) {
    setLayout(parseLayout(q.data.layout));
    setDirty(false);
    setInitFromId(q.data.id);
  }

  const addWidget = (type: WidgetType) => {
    const next: WidgetInstance = { id: newId(), type };
    setLayout((l) => ({ widgets: [...l.widgets, next] }));
    setDirty(true);
  };
  const removeWidget = (id: string) => {
    setLayout((l) => ({ widgets: l.widgets.filter((w) => w.id !== id) }));
    setDirty(true);
  };
  const move = (id: string, delta: -1 | 1) => {
    setLayout((l) => {
      const idx = l.widgets.findIndex((w) => w.id === id);
      const target = idx + delta;
      if (idx < 0 || target < 0 || target >= l.widgets.length) return l;
      const next = [...l.widgets];
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item!);
      return { widgets: next };
    });
    setDirty(true);
  };

  const save = () => {
    update.mutate(
      { dashboardId, layout },
      {
        onSuccess: () => {
          setDirty(false);
          q.refetch();
        },
      },
    );
  };

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

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-12">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <Link
            href={
              `/guild/${guildId}/team/${teamId}/dashboard/${dashboardId}` as Route
            }
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            ← View
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Editing: {q.data.name}
          </h1>
          <p className="text-muted-foreground text-sm">
            {layout.widgets.length} widget{layout.widgets.length === 1 ? "" : "s"}
            {dirty && (
              <span className="text-amber-400"> · unsaved changes</span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={!dirty || update.isPending}>
            {update.isPending ? "Saving…" : "Save layout"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm("Delete this dashboard? This cannot be undone."))
                remove.mutate({ dashboardId });
            }}
          >
            {remove.isPending ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Add a widget</CardTitle>
          <CardDescription>
            Each widget reads from the team&apos;s latest snapshot data. Re-order
            with the arrows once added.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {WIDGET_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => addWidget(type)}
                className="border-border hover:border-primary hover:bg-muted/30 rounded-md border p-3 text-left transition-colors"
              >
                <p className="text-sm font-medium">{WIDGET_META[type].title}</p>
                <p className="text-muted-foreground text-xs">
                  {WIDGET_META[type].description}
                </p>
              </button>
            ))}
          </div>
        </CardContent>
        <CardFooter>
          {update.error && (
            <p className="text-destructive text-sm" role="alert">
              {update.error.message}
            </p>
          )}
        </CardFooter>
      </Card>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Current widgets</h2>
        {layout.widgets.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No widgets yet. Pick one from the palette above.
          </p>
        ) : (
          <ul className="space-y-3">
            {layout.widgets.map((w, i) => (
              <li key={w.id} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground text-xs">
                    {i + 1}. {WIDGET_META[w.type].title}
                  </span>
                  <div className="flex gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => move(w.id, -1)}
                      disabled={i === 0}
                    >
                      ↑
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => move(w.id, 1)}
                      disabled={i === layout.widgets.length - 1}
                    >
                      ↓
                    </Button>
                    <Button
                      size="xs"
                      variant="destructive"
                      onClick={() => removeWidget(w.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                <WidgetRender instance={w} raidTeamId={teamId} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
