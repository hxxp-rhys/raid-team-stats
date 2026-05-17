"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";

import { api } from "@/lib/trpc-client";
import {
  DESKTOP_GRID_COLS,
  MOBILE_GRID_COLS,
  ROW_HEIGHT_PX,
  WIDGET_DEFAULT_SIZE,
  newTabId,
  parseLayout,
  resolveDefaultTabId,
  type DashboardLayout,
  type DashboardTab,
  type WidgetInstance,
  type WidgetType,
} from "@/lib/widgets/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import { TabBar } from "./tab-bar";
import { WidgetCell } from "./widget-cell";
import { MembersModal } from "./modals/members";
import { AddWidgetModal } from "./modals/add-widget";
import { ShareModal } from "./modals/share";
import { ScheduleModal } from "./modals/schedule";

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `w-${Date.now()}-${Math.random()}`;

const SAVE_DEBOUNCE_MS = 800;

/** Compact relative-age label, e.g. "5m ago" / "3h ago" / "2d ago". */
function relativeAge(fromMs: number, nowMs: number): string {
  const diff = nowMs - fromMs;
  if (diff < 60_000) return "just now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * The Dashboard Control Panel — the team-detail page now IS the control
 * panel for that team's dashboards.
 *
 * Layout:
 *   [Header: team name + dashboard picker + mobile toggle]
 *   [Sidebar | Tab bar above grid              ]
 *   [        | Widget grid                      ]
 *
 * Sidebar buttons each open a lightbox modal (members / add widget / share)
 * or fire an immediate action (refresh). Tab bar supports +-add and right-
 * click context menu (set default / rename / duplicate / close). Widget
 * cells render the registered widget and, in edit mode, expose a remove
 * button + bottom-right resize handle.
 *
 * Mobile-view toggle switches the editor (and the rendered preview) over to
 * the `mobileTabs` parallel layout. Edits made while toggled affect ONLY
 * the mobile layout.
 */
export function ControlPanel({
  guildId,
  teamId,
}: {
  guildId: string;
  teamId: string;
}) {
  // ─── Source data ─────────────────────────────────────────────────────────
  const team = api.raidTeam.get.useQuery({ raidTeamId: teamId });
  const dashboards = api.dashboard.list.useQuery({ raidTeamId: teamId });
  const refresh = api.raidTeam.triggerTeamRefresh.useMutation();

  // ─── Active dashboard selection ──────────────────────────────────────────
  // Derived during render (no effect): the explicitly-picked dashboard, else
  // the first one once the list loads. `pickedDashboardId` is only set by an
  // action (creating a dashboard), never an effect.
  const [pickedDashboardId, setPickedDashboardId] = useState<string | null>(
    null,
  );
  const dashboardId =
    pickedDashboardId ?? dashboards.data?.[0]?.id ?? null;

  const dashboardQ = api.dashboard.get.useQuery(
    { dashboardId: dashboardId ?? "" },
    { enabled: !!dashboardId },
  );
  const utils = api.useUtils();
  const update = api.dashboard.updateLayout.useMutation({
    onSuccess: () =>
      utils.dashboard.get.invalidate({ dashboardId: dashboardId ?? "" }),
  });
  const create = api.dashboard.create.useMutation({
    onSuccess: async (d) => {
      await utils.dashboard.list.invalidate({ raidTeamId: teamId });
      setPickedDashboardId(d.id);
    },
  });

  // ─── Layout state (debounced save) ───────────────────────────────────────
  const [layout, setLayout] = useState<DashboardLayout | null>(null);
  const [activeTabId, setActiveTabId] = useState<string>("overview");
  const [mobile, setMobile] = useState(false);
  // `Date.now()` is impure in render — capture once at mount so the
  // "Last refresh" relative label stays pure (react-hooks/purity).
  const [nowMs] = useState(() => Date.now());
  const [pendingFlush, setPendingFlush] = useState(false);
  // Tracks which dashboard id `layout` was initialized from. Using state
  // (not a ref) keeps this the supported "adjust state during render to
  // derive from props" pattern — no ref reads/writes during render.
  const [initFromId, setInitFromId] = useState<string | null>(null);

  // Initialize layout state from the loaded dashboard. Re-fires when the
  // dashboard id changes (switching dashboards).
  if (dashboardQ.data && initFromId !== dashboardQ.data.id) {
    const parsed = parseLayout(dashboardQ.data.layout);
    setInitFromId(dashboardQ.data.id);
    setLayout(parsed);
    setActiveTabId(resolveDefaultTabId(parsed));
  }

  // Auto-save: debounced flush of the current layout. Sequential edits coalesce.
  useEffect(() => {
    if (!layout || !dashboardId || !pendingFlush) return;
    const timer = window.setTimeout(() => {
      update.mutate({ dashboardId, layout });
      setPendingFlush(false);
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [layout, dashboardId, pendingFlush, update]);

  // Which `tabs` array are we editing? Mobile toggle picks `mobileTabs`; if
  // it doesn't exist yet, materialize an empty parallel set on first write.
  const currentTabs: DashboardTab[] = useMemo(() => {
    if (!layout) return [];
    if (mobile && layout.mobileTabs && layout.mobileTabs.length > 0) {
      return layout.mobileTabs;
    }
    if (mobile) {
      // No mobile layout yet — derive read-only preview from desktop tabs
      // with widgets full-mobile-width.
      return layout.tabs.map((t) => ({
        ...t,
        widgets: t.widgets.map((w) => ({
          ...w,
          cols: MOBILE_GRID_COLS,
        })),
      }));
    }
    return layout.tabs;
  }, [layout, mobile]);
  const activeTab = currentTabs.find((t) => t.id === activeTabId);

  const writeLayout = useCallback(
    (mutator: (l: DashboardLayout) => DashboardLayout) => {
      setLayout((l) => (l ? mutator(l) : l));
      setPendingFlush(true);
    },
    [],
  );

  const updateCurrentTab = useCallback(
    (fn: (t: DashboardTab) => DashboardTab) => {
      writeLayout((l) => {
        if (mobile) {
          // Ensure mobileTabs is materialised before mutation; copy desktop
          // layout as a starting point so the user has something to edit.
          const base =
            l.mobileTabs && l.mobileTabs.length > 0
              ? l.mobileTabs
              : l.tabs.map((t) => ({
                  ...t,
                  widgets: t.widgets.map((w) => ({
                    ...w,
                    cols: MOBILE_GRID_COLS,
                  })),
                }));
          return {
            ...l,
            mobileTabs: base.map((t) => (t.id === activeTabId ? fn(t) : t)),
          };
        }
        return {
          ...l,
          tabs: l.tabs.map((t) => (t.id === activeTabId ? fn(t) : t)),
        };
      });
    },
    [writeLayout, mobile, activeTabId],
  );

  // ─── Tab actions ─────────────────────────────────────────────────────────

  const addTab = () => {
    if (!layout) return;
    const id = newTabId();
    const blank: DashboardTab = {
      id,
      name: `Tab ${currentTabs.length + 1}`,
      widgets: [],
    };
    writeLayout((l) => {
      if (mobile) {
        const base = l.mobileTabs ?? l.tabs;
        return { ...l, mobileTabs: [...base, blank] };
      }
      return { ...l, tabs: [...l.tabs, blank] };
    });
    setActiveTabId(id);
  };

  const renameTab = (id: string, name: string) =>
    writeLayout((l) => {
      const arr = mobile ? (l.mobileTabs ?? l.tabs) : l.tabs;
      const updated = arr.map((t) => (t.id === id ? { ...t, name } : t));
      return mobile ? { ...l, mobileTabs: updated } : { ...l, tabs: updated };
    });

  const setDefaultTab = (id: string) =>
    writeLayout((l) => ({ ...l, defaultTabId: id }));

  const duplicateTab = (id: string) =>
    writeLayout((l) => {
      const arr = mobile ? (l.mobileTabs ?? l.tabs) : l.tabs;
      const src = arr.find((t) => t.id === id);
      if (!src) return l;
      const copy: DashboardTab = {
        id: newTabId(),
        name: `${src.name} (copy)`,
        widgets: src.widgets.map((w) => ({ ...w, id: newId() })),
      };
      const idx = arr.findIndex((t) => t.id === id);
      const next = [...arr.slice(0, idx + 1), copy, ...arr.slice(idx + 1)];
      setActiveTabId(copy.id);
      return mobile ? { ...l, mobileTabs: next } : { ...l, tabs: next };
    });

  const closeTab = (id: string) => {
    if (!layout) return;
    const arr = mobile ? (layout.mobileTabs ?? layout.tabs) : layout.tabs;
    if (arr.length === 1) {
      window.alert("A dashboard needs at least one tab.");
      return;
    }
    const tab = arr.find((t) => t.id === id);
    if (
      tab &&
      tab.widgets.length > 0 &&
      !window.confirm(
        `Tab "${tab.name}" has ${tab.widgets.length} widget${
          tab.widgets.length === 1 ? "" : "s"
        }. Close anyway?`,
      )
    ) {
      return;
    }
    writeLayout((l) => {
      const sourceArr = mobile ? (l.mobileTabs ?? l.tabs) : l.tabs;
      const next = sourceArr.filter((t) => t.id !== id);
      if (activeTabId === id) {
        const fallback = next[0]?.id;
        if (fallback) setActiveTabId(fallback);
      }
      // Clear defaultTabId pointer if it referenced the removed tab.
      const nextDefault = l.defaultTabId === id ? next[0]?.id : l.defaultTabId;
      return mobile
        ? { ...l, mobileTabs: next, defaultTabId: nextDefault }
        : { ...l, tabs: next, defaultTabId: nextDefault };
    });
  };

  // ─── Widget actions ──────────────────────────────────────────────────────

  const addWidget = (type: WidgetType) => {
    const recommended = WIDGET_DEFAULT_SIZE[type];
    const inst: WidgetInstance = {
      id: newId(),
      type,
      cols: mobile ? MOBILE_GRID_COLS : recommended.cols,
      rows: recommended.rows,
    };
    updateCurrentTab((t) => ({ ...t, widgets: [...t.widgets, inst] }));
  };

  const removeWidget = (widgetId: string) => {
    updateCurrentTab((t) => ({
      ...t,
      widgets: t.widgets.filter((w) => w.id !== widgetId),
    }));
  };

  const resizeWidget = (widgetId: string, cols: number, rows: number) => {
    updateCurrentTab((t) => ({
      ...t,
      widgets: t.widgets.map((w) =>
        w.id === widgetId ? { ...w, cols, rows } : w,
      ),
    }));
  };

  const moveWidget = (widgetId: string, x: number, y: number) => {
    updateCurrentTab((t) => ({
      ...t,
      widgets: t.widgets.map((w) =>
        w.id === widgetId ? { ...w, x, y } : w,
      ),
    }));
  };

  // ─── Edit-mode + permissions ─────────────────────────────────────────────
  // The real permission gates live server-side; we just want a hint here for
  // UX. Anyone the API lets see `eligibleCharacters` (CO_LEADER+ or guild
  // OWNER/OFFICER or platform admin) is treated as staff for the purposes
  // of showing edit affordances.
  const eligibleHint = api.raidTeam.eligibleCharacters.useQuery(
    { raidTeamId: teamId },
    { retry: false },
  );
  const editing = !eligibleHint.error;

  // Modal open state
  const [openMembers, setOpenMembers] = useState(false);
  const [openAddWidget, setOpenAddWidget] = useState(false);
  const [openShare, setOpenShare] = useState(false);
  const [openSchedule, setOpenSchedule] = useState(false);

  // ─── Render ──────────────────────────────────────────────────────────────
  if (team.isPending || dashboards.isPending) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-12">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
    );
  }
  if (team.error) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>Team not found</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-destructive text-sm">{team.error.message}</p>
          </CardContent>
        </Card>
      </main>
    );
  }
  const t = team.data!;

  // "Last refresh" = the most recent successful per-character sync across
  // the active roster, falling back to the team-level manual-refresh stamp.
  // This replaces the standalone Roster-freshness widget.
  const lastRefreshMs = (() => {
    let max = t.lastRefreshAt ? new Date(t.lastRefreshAt).getTime() : 0;
    for (const m of t.memberships) {
      const ts = m.character.lastSyncedAt;
      if (ts) max = Math.max(max, new Date(ts).getTime());
    }
    return max > 0 ? max : null;
  })();

  // No dashboards yet → show a one-shot create form rather than the empty
  // grid. Once a dashboard exists, the picker on the header navigates.
  if (dashboards.data && dashboards.data.length === 0) {
    return (
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-12">
        <header>
          <Link
            href={"/guild" as Route}
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            ← Guilds
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {t.name}
          </h1>
          <p className="text-muted-foreground text-sm">
            No dashboards yet. Create the first one to start adding widgets.
          </p>
        </header>
        <Card>
          <CardHeader>
            <CardTitle>Create a dashboard</CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() =>
                create.mutate({ raidTeamId: teamId, name: "Overview" })
              }
              disabled={create.isPending}
            >
              {create.isPending ? "Creating…" : "Create Overview dashboard"}
            </Button>
            {create.error && (
              <p className="text-destructive mt-2 text-sm" role="alert">
                {create.error.message}
              </p>
            )}
          </CardContent>
        </Card>
      </main>
    );
  }

  const gridCols = mobile ? MOBILE_GRID_COLS : DESKTOP_GRID_COLS;

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            href={"/guild" as Route}
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            ← Guilds
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {t.name}
          </h1>
          <p className="text-muted-foreground text-sm">
            Dashboard Control Panel · {t.memberships.length} active member
            {t.memberships.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5 text-sm">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label
              className={cn(
                "border-border bg-background inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-sm",
                mobile && "border-primary text-primary",
              )}
              title="Toggle mobile-layout editing"
            >
              <input
                type="checkbox"
                checked={mobile}
                onChange={(e) => setMobile(e.target.checked)}
                className="sr-only"
              />
              <span aria-hidden>📱</span>
              <span>Mobile view</span>
            </label>
            {pendingFlush ? (
              <span className="text-amber-400 text-xs">Saving…</span>
            ) : update.error ? (
              <span className="text-destructive text-xs" role="alert">
                Save failed
              </span>
            ) : (
              <span className="text-muted-foreground text-xs">Auto-saved</span>
            )}
          </div>
          <span
            className="text-muted-foreground text-xs"
            title={
              lastRefreshMs
                ? new Date(lastRefreshMs).toLocaleString()
                : "No sync recorded yet"
            }
          >
            Last refresh:{" "}
            <span className="text-foreground font-medium">
              {lastRefreshMs ? relativeAge(lastRefreshMs, nowMs) : "never"}
            </span>
          </span>
        </div>
      </header>

      {/* Horizontal action bar */}
      <div className="border-border bg-card mb-3 flex flex-wrap items-center gap-1 rounded-lg border p-1.5">
        <ActionButton
          icon="👥"
          label="Members"
          onClick={() => setOpenMembers(true)}
        />
        {editing && (
          <ActionButton
            icon="＋"
            label="Add widget"
            onClick={() => setOpenAddWidget(true)}
          />
        )}
        {editing && (
          <ActionButton
            icon="⏱"
            label="Auto-refresh"
            onClick={() => setOpenSchedule(true)}
          />
        )}
        <ActionButton
          icon="↻"
          label={refresh.isPending ? "Refreshing…" : "Refresh data"}
          onClick={() => refresh.mutate({ raidTeamId: teamId })}
          disabled={refresh.isPending}
        />
        <ActionButton
          icon="🔗"
          label="Share"
          onClick={() => setOpenShare(true)}
          disabled={!dashboardId}
        />
      </div>

      {/* Refresh status — its own line so it never crowds the action bar
          buttons or the share UI. Auto-clears on the next interaction. */}
      {(refresh.data || refresh.error) && !refresh.isPending && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "mb-3 rounded-md border px-3 py-2 text-xs",
            refresh.error
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-border bg-muted/40 text-muted-foreground",
          )}
        >
          {refresh.error
            ? `Refresh failed: ${refresh.error.message}. Try again in a moment.`
            : refresh.data?.ok
              ? `Queued a fresh sync for ${refresh.data.enqueued} character${
                  refresh.data.enqueued === 1 ? "" : "s"
                }. New data appears within ~1 minute.`
              : refresh.data && refresh.data.ok === false
                ? refresh.data.reason === "no_members"
                  ? "No active members to refresh."
                  : "Refresh was rate-limited. Try again shortly."
                : null}
        </div>
      )}

      <section className="space-y-3 min-w-0">
        {layout && (
          <TabBar
            tabs={currentTabs}
            activeTabId={activeTabId}
            defaultTabId={layout.defaultTabId}
            editing={editing}
            onSelect={setActiveTabId}
            onAdd={addTab}
            onRename={renameTab}
            onAction={(id, a) => {
              if (a === "set-default") setDefaultTab(id);
              else if (a === "duplicate") duplicateTab(id);
              else if (a === "close") closeTab(id);
              // rename is handled inline in TabBar
            }}
          />
        )}

        {!activeTab || activeTab.widgets.length === 0 ? (
          <p className="text-muted-foreground px-2 py-8 text-center text-sm">
            No widgets on this tab.
            {editing && " Click “＋ Add widget” above to start."}
          </p>
        ) : (
          <div
            className="grid gap-2"
            style={{
              gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
              gridAutoRows: `${ROW_HEIGHT_PX}px`,
              gridAutoFlow: "dense",
            }}
          >
            {activeTab.widgets.map((w) => (
              <WidgetCell
                key={w.id}
                widget={w}
                raidTeamId={teamId}
                editing={editing}
                isMobile={mobile}
                onRemove={removeWidget}
                onResize={resizeWidget}
                onMove={moveWidget}
              />
            ))}
          </div>
        )}
      </section>

      <MembersModal
        open={openMembers}
        onClose={() => setOpenMembers(false)}
        teamId={teamId}
      />
      <AddWidgetModal
        open={openAddWidget}
        onClose={() => setOpenAddWidget(false)}
        onPick={addWidget}
      />
      <ShareModal
        open={openShare}
        onClose={() => setOpenShare(false)}
        dashboardId={dashboardId}
      />
      <ScheduleModal
        open={openSchedule}
        onClose={() => setOpenSchedule(false)}
        raidTeamId={teamId}
      />
      {/* Carry guildId via data-attr so future deep-links / breadcrumbs can read it. */}
      <span hidden data-guild={guildId} />
    </main>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  hint,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="hover:bg-muted disabled:opacity-50 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
    >
      <span aria-hidden className="text-base">
        {icon}
      </span>
      <span>{label}</span>
      {hint && (
        <span className="text-muted-foreground text-[10px]">· {hint}</span>
      )}
    </button>
  );
}
