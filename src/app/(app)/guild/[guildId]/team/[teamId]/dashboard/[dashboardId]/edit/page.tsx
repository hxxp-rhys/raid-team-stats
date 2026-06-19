"use client";

import { Suspense, use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

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
  newTabId,
  parseLayout,
  WIDGET_META,
  WIDGET_TYPES,
  type DashboardLayout,
  type WidgetInstance,
  type WidgetType,
} from "@/lib/widgets/types";
import { SortableWidget } from "./sortable-widget";

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

const emptyLayout = (): DashboardLayout => ({
  version: 2,
  tabs: [{ id: "overview", name: "Overview", widgets: [] }],
});

function Inner({ params }: { params: Params }) {
  const { guildId, teamId, dashboardId } = use(params);
  const router = useRouter();

  const q = api.dashboard.get.useQuery({ dashboardId });
  const update = api.dashboard.updateLayout.useMutation();
  const remove = api.dashboard.delete.useMutation({
    onSuccess: () =>
      router.push(`/guild/${guildId}/team/${teamId}/dashboard` as Route),
  });

  const [layout, setLayout] = useState<DashboardLayout>(emptyLayout);
  const [activeTabId, setActiveTabId] = useState<string>("overview");
  const [dirty, setDirty] = useState(false);
  const [initFromId, setInitFromId] = useState<string | null>(null);
  if (q.data && initFromId !== q.data.id) {
    const parsed = parseLayout(q.data.layout);
    setLayout(parsed);
    setActiveTabId(parsed.tabs[0]?.id ?? "overview");
    setDirty(false);
    setInitFromId(q.data.id);
  }

  const totalWidgets = layout.tabs.reduce((s, t) => s + t.widgets.length, 0);
  const activeIndex = Math.max(
    0,
    layout.tabs.findIndex((t) => t.id === activeTabId),
  );
  const activeTab = layout.tabs[activeIndex];

  const updateActiveTab = (
    fn: (widgets: WidgetInstance[]) => WidgetInstance[],
  ) => {
    setLayout((l) => ({
      ...l,
      tabs: l.tabs.map((t, i) =>
        i === activeIndex ? { ...t, widgets: fn(t.widgets) } : t,
      ),
    }));
    setDirty(true);
  };

  const addWidget = (type: WidgetType) => {
    const next: WidgetInstance = { id: newId(), type };
    updateActiveTab((ws) => [...ws, next]);
  };
  const removeWidget = (id: string) =>
    updateActiveTab((ws) => ws.filter((w) => w.id !== id));
  const updateWidgetConfig = (id: string, config: Record<string, unknown>) =>
    updateActiveTab((ws) =>
      ws.map((w) => (w.id === id ? { ...w, config } : w)),
    );

  const addTab = () => {
    const id = newTabId();
    setLayout((l) => ({
      ...l,
      tabs: [...l.tabs, { id, name: `Tab ${l.tabs.length + 1}`, widgets: [] }],
    }));
    setActiveTabId(id);
    setDirty(true);
  };

  const renameTab = (id: string, name: string) => {
    setLayout((l) => ({
      ...l,
      tabs: l.tabs.map((t) => (t.id === id ? { ...t, name } : t)),
    }));
    setDirty(true);
  };

  const deleteTab = (id: string) => {
    if (layout.tabs.length === 1) {
      window.alert("A dashboard needs at least one tab.");
      return;
    }
    const tab = layout.tabs.find((t) => t.id === id);
    if (
      tab &&
      tab.widgets.length > 0 &&
      !window.confirm(
        `Tab "${tab.name}" has ${tab.widgets.length} widget${tab.widgets.length === 1 ? "" : "s"}. Delete anyway?`,
      )
    ) {
      return;
    }
    setLayout((l) => ({
      ...l,
      tabs: l.tabs.filter((t) => t.id !== id),
    }));
    if (activeTabId === id) {
      const fallback =
        layout.tabs.find((t) => t.id !== id)?.id ?? "overview";
      setActiveTabId(fallback);
    }
    setDirty(true);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (!activeTab) return;
    const oldIndex = activeTab.widgets.findIndex((w) => w.id === active.id);
    const newIndex = activeTab.widgets.findIndex((w) => w.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    updateActiveTab((ws) => arrayMove(ws, oldIndex, newIndex));
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
            {totalWidgets} widget{totalWidgets === 1 ? "" : "s"} across{" "}
            {layout.tabs.length} tab{layout.tabs.length === 1 ? "" : "s"}
            {dirty && <span className="text-amber-400"> · unsaved changes</span>}
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
          <CardTitle>Tabs</CardTitle>
          <CardDescription>
            Group widgets into themed tabs (e.g. Readiness, Progression, M+).
            Rename inline; delete with the ✕ button.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            {layout.tabs.map((t) => {
              const isActive = t.id === activeTab?.id;
              return (
                <div
                  key={t.id}
                  className={`flex items-center gap-1 rounded-md border px-2 py-1 text-sm transition-colors ${
                    isActive
                      ? "border-primary bg-muted"
                      : "border-border bg-background"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveTabId(t.id)}
                    className="font-medium"
                  >
                    {t.name}{" "}
                    <span className="text-muted-foreground text-xs">
                      ({t.widgets.length})
                    </span>
                  </button>
                  {isActive && (
                    <>
                      <input
                        aria-label="Rename tab"
                        value={t.name}
                        onChange={(e) => renameTab(t.id, e.target.value)}
                        className="bg-background border-border h-6 w-24 rounded border px-1 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => deleteTab(t.id)}
                        className="text-muted-foreground hover:text-destructive ml-1 text-xs"
                        aria-label={`Delete tab ${t.name}`}
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>
              );
            })}
            <Button size="sm" variant="outline" onClick={addTab}>
              + Add tab
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add a widget to “{activeTab?.name ?? "this tab"}”</CardTitle>
          <CardDescription>
            Each widget reads from the team&apos;s latest snapshot data. Drag
            widgets in the list below to reorder within the active tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-5">
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
        <h2 className="text-lg font-semibold tracking-tight">
          Widgets on “{activeTab?.name ?? "this tab"}”
        </h2>
        {(activeTab?.widgets.length ?? 0) === 0 ? (
          <p className="text-muted-foreground text-sm">
            No widgets on this tab yet. Pick one from the palette above.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={(activeTab?.widgets ?? []).map((w) => w.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="space-y-3">
                {activeTab?.widgets.map((w, i) => (
                  <SortableWidget
                    key={w.id}
                    widget={w}
                    raidTeamId={teamId}
                    index={i}
                    onRemove={removeWidget}
                    onConfigChange={updateWidgetConfig}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </section>
    </main>
  );
}
