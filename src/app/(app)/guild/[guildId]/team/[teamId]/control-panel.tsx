"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";

import { api } from "@/lib/trpc-client";
import {
  DEFAULT_WIDGET_COLS,
  DEFAULT_WIDGET_ROWS,
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
import {
  autoPlaceWidgets,
  moveWidgetWithPush,
  resizeWidgetWithPush,
} from "@/lib/widgets/layout-engine";
import { useStrictLayout } from "@/lib/widgets/use-strict-layout";
import {
  sortForMobileStack,
  useIsMobile,
} from "@/lib/widgets/use-is-mobile";
import { isLightTheme, isValidTheme, THEME_IDS, THEME_META } from "@/lib/theme";
import {
  useRefreshInterval,
  REFRESH_OPTIONS,
} from "@/lib/widgets/use-refresh-interval";
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

  // ─── Auto-refresh (live updates) ─────────────────────────────────────────
  // A single polling observer on the SHARED snapshot query key. Every widget
  // calls `snapshot.latestForTeam({ raidTeamId })` with the same input, so
  // React Query dedupes them into one query; this observer's refetchInterval
  // drives that query's refetch and ALL widgets receive the fresh data — no
  // per-widget wiring. `refetchIntervalInBackground` stays false (default) so
  // a hidden tab doesn't burn the WCL/Blizzard budget. Off by default.
  const { intervalMs: refreshIntervalMs, setIntervalMs: setRefreshIntervalMs } =
    useRefreshInterval();
  api.snapshot.latestForTeam.useQuery(
    { raidTeamId: teamId },
    {
      refetchInterval: refreshIntervalMs,
      refetchOnWindowFocus: false,
    },
  );

  // ─── Manual data-refresh + live progress ─────────────────────────────────
  // Mirrors the AccountRefreshButton pattern: capture `{ since, total }` on
  // mutation success, poll `raidTeam.syncProgress` every 2s until all
  // characters have synced, then stop. Stable EPOCH placeholder keeps the
  // disabled-query key from churning while no refresh is in flight.
  //
  // Reload note: this state is component-local — refreshing the page loses
  // the progress bar even though the server-side sync continues. The
  // underlying character timestamps still update via `raidTeam.get` polling
  // so the rest of the UI corrects itself; we accept the lost progress bar
  // as a v1 limitation rather than persist to sessionStorage.
  const REFRESH_EPOCH = useMemo(() => new Date(0), []);
  const [refreshProgress, setRefreshProgress] = useState<{
    since: Date;
    total: number;
  } | null>(null);
  const refresh = api.raidTeam.triggerTeamRefresh.useMutation({
    onSuccess: (data) => {
      if (data.ok && data.enqueued > 0) {
        // Drop any cached syncProgress rows from a previous refresh so the
        // next poll always starts from a fresh server fetch — defensive
        // against React Query reusing stale data across keys.
        void utils.raidTeam.syncProgress.invalidate();
        setRefreshProgress({ since: data.at, total: data.enqueued });
      } else {
        setRefreshProgress(null);
      }
    },
    onError: () => setRefreshProgress(null),
  });
  const refreshSync = api.raidTeam.syncProgress.useQuery(
    { raidTeamId: teamId, since: refreshProgress?.since ?? REFRESH_EPOCH },
    {
      enabled: refreshProgress != null,
      refetchInterval: (q) => {
        const d = q.state.data;
        return d && d.synced >= d.total ? false : 2000;
      },
      refetchOnWindowFocus: false,
    },
  );
  // Accuracy: take BOTH the numerator and denominator from the same source —
  // `syncProgress` (which counts active members whose lastSyncedAt advanced
  // past `since`). Mixing the mutation's `enqueued` (denominator) with
  // syncProgress's `synced` (numerator) could disagree; using one source
  // makes "X of Y" increment exactly as each member's data lands. Before the
  // first poll returns we fall back to the enqueued count so the bar shows a
  // sensible denominator immediately.
  const refreshTotal = refreshProgress
    ? (refreshSync.data?.total ?? refreshProgress.total)
    : 0;
  const refreshSynced = refreshProgress
    ? Math.min(refreshSync.data?.synced ?? 0, refreshTotal)
    : 0;
  const refreshDone =
    refreshProgress != null && refreshTotal > 0 && refreshSynced >= refreshTotal;
  const refreshActive = refreshProgress != null && !refreshDone;

  // Auto-dismiss the progress bar 5s after it completes. Clearing
  // refreshProgress + resetting the mutation hides the whole status box.
  // Depend only on `refreshDone` so re-renders (e.g. the auto-refresh poll)
  // don't keep resetting the timer.
  useEffect(() => {
    if (!refreshDone) return;
    const id = window.setTimeout(() => {
      setRefreshProgress(null);
      refresh.reset();
    }, 5000);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshDone]);

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
  // Real phones always get the mobile layout — the header toggle is a
  // desktop PREVIEW of it. All layout reads/writes branch on mobileMode so
  // a phone user editing affects the mobile layout, never the desktop one.
  const isSmallScreen = useIsMobile();
  const mobileMode = mobile || isSmallScreen;
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

  // Apply the dashboard's OWN theme to <html> while this dashboard is open —
  // for the owner editing it AND any member viewing it, mirroring the
  // /share view. So picking a "Share theme" repaints the dashboard
  // immediately, not only on the shared link. The user's personal theme is
  // restored on unmount (navigating away) and whenever the dashboard theme
  // is cleared.
  const dashTheme = layout?.theme;
  useEffect(() => {
    if (!dashTheme || !isValidTheme(dashTheme)) return;
    const el = document.documentElement;
    const prevTheme = el.getAttribute("data-theme");
    const prevDark = el.classList.contains("dark");
    el.setAttribute("data-theme", dashTheme);
    el.classList.toggle("dark", !isLightTheme(dashTheme));
    return () => {
      if (prevTheme !== null) el.setAttribute("data-theme", prevTheme);
      else el.removeAttribute("data-theme");
      el.classList.toggle("dark", prevDark);
    };
  }, [dashTheme]);

  // Which `tabs` array are we editing? Mobile toggle picks `mobileTabs`; if
  // it doesn't exist yet, materialize an empty parallel set on first write.
  const currentTabs: DashboardTab[] = useMemo(() => {
    if (!layout) return [];
    if (mobileMode && layout.mobileTabs && layout.mobileTabs.length > 0) {
      return layout.mobileTabs;
    }
    if (mobileMode) {
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
  }, [layout, mobileMode]);
  const activeTab = currentTabs.find((t) => t.id === activeTabId);

  // Returning the input `l` from the mutator signals "no change" — skip the
  // debounced save instead of writing identical layout JSON back to the DB.
  // Strict-mode blocks (collisions) and any future "drag cancelled" branches
  // can return early without triggering network round-trips.
  const writeLayout = useCallback(
    (mutator: (l: DashboardLayout) => DashboardLayout) => {
      let dirty = false;
      setLayout((l) => {
        if (!l) return l;
        const next = mutator(l);
        if (next !== l) dirty = true;
        return next;
      });
      if (dirty) setPendingFlush(true);
    },
    [],
  );

  // Same convention as writeLayout: the `fn` can return its input `t`
  // unchanged to signal "no-op". We detect that here and short-circuit the
  // outer layout rebuild so writeLayout sees `l` referentially equal and
  // skips setPendingFlush.
  const updateCurrentTab = useCallback(
    (fn: (t: DashboardTab) => DashboardTab) => {
      writeLayout((l) => {
        if (mobileMode) {
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
          let changed = base !== l.mobileTabs;
          const nextTabs = base.map((t) => {
            if (t.id !== activeTabId) return t;
            const updated = fn(t);
            if (updated !== t) changed = true;
            return updated;
          });
          if (!changed) return l;
          return { ...l, mobileTabs: nextTabs };
        }
        let changed = false;
        const nextTabs = l.tabs.map((t) => {
          if (t.id !== activeTabId) return t;
          const updated = fn(t);
          if (updated !== t) changed = true;
          return updated;
        });
        if (!changed) return l;
        return { ...l, tabs: nextTabs };
      });
    },
    [writeLayout, mobileMode, activeTabId],
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
      if (mobileMode) {
        const base = l.mobileTabs ?? l.tabs;
        return { ...l, mobileTabs: [...base, blank] };
      }
      return { ...l, tabs: [...l.tabs, blank] };
    });
    setActiveTabId(id);
  };

  const renameTab = (id: string, name: string) =>
    writeLayout((l) => {
      const arr = mobileMode ? (l.mobileTabs ?? l.tabs) : l.tabs;
      const updated = arr.map((t) => (t.id === id ? { ...t, name } : t));
      return mobileMode ? { ...l, mobileTabs: updated } : { ...l, tabs: updated };
    });

  const setDefaultTab = (id: string) =>
    writeLayout((l) => ({ ...l, defaultTabId: id }));

  const duplicateTab = (id: string) =>
    writeLayout((l) => {
      const arr = mobileMode ? (l.mobileTabs ?? l.tabs) : l.tabs;
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
      return mobileMode ? { ...l, mobileTabs: next } : { ...l, tabs: next };
    });

  const closeTab = (id: string) => {
    if (!layout) return;
    const arr = mobileMode ? (layout.mobileTabs ?? layout.tabs) : layout.tabs;
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
      const sourceArr = mobileMode ? (l.mobileTabs ?? l.tabs) : l.tabs;
      const next = sourceArr.filter((t) => t.id !== id);
      if (activeTabId === id) {
        const fallback = next[0]?.id;
        if (fallback) setActiveTabId(fallback);
      }
      // Clear defaultTabId pointer if it referenced the removed tab.
      const nextDefault = l.defaultTabId === id ? next[0]?.id : l.defaultTabId;
      return mobileMode
        ? { ...l, mobileTabs: next, defaultTabId: nextDefault }
        : { ...l, tabs: next, defaultTabId: nextDefault };
    });
  };

  // ─── Widget actions ──────────────────────────────────────────────────────

  // Add one or many widgets in a single layout write (the debounced save then
  // persists the whole batch in one round-trip). Each widget gets its
  // recommended default size, narrowed to one column in mobile mode.
  const addWidgets = (types: WidgetType[]) => {
    if (types.length === 0) return;
    const insts: WidgetInstance[] = types.map((type) => {
      const recommended = WIDGET_DEFAULT_SIZE[type];
      return {
        id: newId(),
        type,
        cols: mobileMode ? MOBILE_GRID_COLS : recommended.cols,
        rows: recommended.rows,
      };
    });
    updateCurrentTab((t) => ({ ...t, widgets: [...t.widgets, ...insts] }));
  };

  const removeWidget = useCallback(
    (widgetId: string) => {
      updateCurrentTab((t) => ({
        ...t,
        widgets: t.widgets.filter((w) => w.id !== widgetId),
      }));
    },
    [updateCurrentTab],
  );

  // Mobile stack reorder: swap with the neighbor in stack order, then
  // persist the order by writing sequential y values (x pinned to 0). Only
  // reachable in mobileMode, so this always lands in mobileTabs.
  const reorderWidget = (widgetId: string, dir: -1 | 1) => {
    updateCurrentTab((t) => {
      const ordered = sortForMobileStack(t.widgets);
      const idx = ordered.findIndex((w) => w.id === widgetId);
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= ordered.length) return t;
      [ordered[idx], ordered[j]] = [ordered[j]!, ordered[idx]!];
      const yById = new Map(ordered.map((w, i) => [w.id, i]));
      return {
        ...t,
        widgets: t.widgets.map((w) => ({
          ...w,
          y: yById.get(w.id)!,
          x: 0,
        })),
      };
    });
  };

  // ─── Strict-layout (collision prevention) ────────────────────────────────
  // Default-on user preference (localStorage-backed). When ON, a resize or
  // move that would overlap another placed widget is silently dropped —
  // the widget snaps back to its prior position via React state. The
  // toggle lives in the header and applies to every dashboard the user
  // opens in this browser.
  const { strict: strictLayout, setStrict: setStrictLayout } =
    useStrictLayout();
  const strictDefaults = useMemo(
    () => ({ cols: DEFAULT_WIDGET_COLS, rows: DEFAULT_WIDGET_ROWS }),
    [],
  );

  // Every desktop widget gets an explicit (x, y) before it renders, so the grid
  // is stable (no CSS auto-flow re-shuffle when one widget becomes placed) and a
  // freshly-added widget is dragged from where it actually sits — not teleported
  // from (0,0). Idempotent + referentially stable once everything is placed.
  const desktopWidgets = useMemo(
    () =>
      activeTab && !mobileMode
        ? autoPlaceWidgets(activeTab.widgets, DESKTOP_GRID_COLS, strictDefaults)
        : (activeTab?.widgets ?? []),
    [activeTab, mobileMode, strictDefaults],
  );

  // ─── Live drag preview ────────────────────────────────────────────────────
  // While a widget is dragged/resized in strict mode, hold its in-progress
  // target geometry here and run the WHOLE grid through the push engine so the
  // other widgets shift in real time (Grafana) — not just on drop. Only the
  // dragged + pushed cells change position, so a memoized WidgetCell keeps the
  // rest from re-rendering. Cleared the moment the gesture commits.
  const [dragPreview, setDragPreview] = useState<
    | { kind: "move"; id: string; x: number; y: number }
    | { kind: "resize"; id: string; cols: number; rows: number }
    | null
  >(null);

  const previewWidgets = useMemo(() => {
    if (!dragPreview || !strictLayout) return desktopWidgets;
    return dragPreview.kind === "move"
      ? moveWidgetWithPush(
          desktopWidgets,
          dragPreview.id,
          dragPreview.x,
          dragPreview.y,
          DESKTOP_GRID_COLS,
          strictDefaults,
        )
      : resizeWidgetWithPush(
          desktopWidgets,
          dragPreview.id,
          dragPreview.cols,
          dragPreview.rows,
          DESKTOP_GRID_COLS,
          strictDefaults,
        );
  }, [dragPreview, strictLayout, desktopWidgets, strictDefaults]);

  // Preview reporters — no-op unless strict (non-strict allows free overlap, so
  // only the dragged widget moves, which it does on its own).
  const onMovePreview = useCallback(
    (id: string, x: number, y: number) => {
      if (!strictLayout) return;
      setDragPreview((p) =>
        p && p.kind === "move" && p.id === id && p.x === x && p.y === y
          ? p
          : { kind: "move", id, x, y },
      );
    },
    [strictLayout],
  );
  const onResizePreview = useCallback(
    (id: string, cols: number, rows: number) => {
      if (!strictLayout) return;
      setDragPreview((p) =>
        p && p.kind === "resize" && p.id === id && p.cols === cols && p.rows === rows
          ? p
          : { kind: "resize", id, cols, rows },
      );
    },
    [strictLayout],
  );

  const resizeWidget = useCallback(
    (widgetId: string, cols: number, rows: number) => {
      updateCurrentTab((t) => {
        // The 2D engine is meaningless in the mobile stack — it normalizes
        // everyone to x:0 / sequential y; stack rendering ignores 2D placement.
        if (strictLayout && !mobileMode) {
          // Strict: grow into neighbors and PUSH them out of the way (Grafana
          // behaviour), auto-placing any unplaced widget first.
          const widgets = resizeWidgetWithPush(
            t.widgets,
            widgetId,
            cols,
            rows,
            DESKTOP_GRID_COLS,
            strictDefaults,
          );
          return widgets === t.widgets ? t : { ...t, widgets };
        }
        return {
          ...t,
          widgets: t.widgets.map((w) =>
            w.id === widgetId ? { ...w, cols, rows } : w,
          ),
        };
      });
      setDragPreview(null);
    },
    [updateCurrentTab, strictLayout, mobileMode, strictDefaults],
  );

  const moveWidget = useCallback(
    (widgetId: string, x: number, y: number) => {
      updateCurrentTab((t) => {
        if (mobileMode) return t; // free 2D move isn't used in the stack
        if (strictLayout) {
          // Strict: drop where the cursor is and shift the widgets it lands on
          // down to accommodate it, then compact gaps (Grafana behaviour).
          const widgets = moveWidgetWithPush(
            t.widgets,
            widgetId,
            x,
            y,
            DESKTOP_GRID_COLS,
            strictDefaults,
          );
          return widgets === t.widgets ? t : { ...t, widgets };
        }
        // Non-strict: overlap is allowed, but still auto-place the rest so they
        // hold a stable position instead of re-flowing (no teleport on drag).
        const base = autoPlaceWidgets(
          t.widgets,
          DESKTOP_GRID_COLS,
          strictDefaults,
        );
        return {
          ...t,
          widgets: base.map((w) =>
            w.id === widgetId
              ? { ...w, x: Math.max(0, x), y: Math.max(0, y) }
              : w,
          ),
        };
      });
      setDragPreview(null);
    },
    [updateCurrentTab, mobileMode, strictLayout, strictDefaults],
  );

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

  const gridCols = mobileMode ? MOBILE_GRID_COLS : DESKTOP_GRID_COLS;

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
          <nav className="mt-2 flex items-center gap-1 text-sm">
            <span className="border-primary bg-muted inline-flex h-8 items-center rounded-md border px-3 font-medium">
              Dashboard
            </span>
            <Link
              href={`/guild/${guildId}/team/${teamId}/calendar` as Route}
              className="border-border bg-background hover:bg-muted inline-flex h-8 items-center rounded-md border px-3 font-medium"
            >
              Calendar
            </Link>
          </nav>
        </div>
        <div className="flex flex-col items-end gap-1.5 text-sm">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {editing && (
              <label
                className={cn(
                  "border-border bg-background inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-sm",
                  strictLayout && "border-primary text-primary",
                )}
                title={
                  strictLayout
                    ? "Strict layout ON — widgets can't overlap. Click to allow overlap."
                    : "Strict layout OFF — widgets may overlap. Click to enforce no-overlap."
                }
              >
                <input
                  type="checkbox"
                  checked={strictLayout}
                  onChange={(e) => setStrictLayout(e.target.checked)}
                  className="sr-only"
                />
                <span aria-hidden>🔒</span>
                <span>Strict layout</span>
              </label>
            )}
            <label
              className={cn(
                "border-border bg-background inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-sm",
                mobileMode && "border-primary text-primary",
                isSmallScreen ? "cursor-default opacity-70" : "cursor-pointer",
              )}
              title={
                isSmallScreen
                  ? "Phone-sized screen detected — the mobile layout is always shown here."
                  : "Preview and edit the phone layout — a separate single-column layout phones get automatically. Independent of the desktop layout."
              }
            >
              <input
                type="checkbox"
                checked={mobileMode}
                disabled={isSmallScreen}
                onChange={(e) => setMobile(e.target.checked)}
                className="sr-only"
              />
              <span aria-hidden>📱</span>
              <span>Mobile View</span>
            </label>
            {/* Auto-refresh period — drives the shared snapshot poll. Visible
                to viewers too (watching a live dashboard during raid). */}
            <label
              className={cn(
                "border-border bg-background inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-sm",
                refreshIntervalMs !== false && "border-primary text-primary",
              )}
              title="Auto-refresh the dashboard data on a timer. Pauses while the tab is in the background."
            >
              <span aria-hidden>🔄</span>
              <span className="sr-only">Auto-refresh period</span>
              <select
                value={refreshIntervalMs === false ? "off" : String(refreshIntervalMs)}
                onChange={(e) =>
                  setRefreshIntervalMs(
                    e.target.value === "off" ? false : Number(e.target.value),
                  )
                }
                className="bg-background cursor-pointer text-sm focus:outline-none"
              >
                {REFRESH_OPTIONS.map((o) => (
                  <option
                    key={o.label}
                    value={o.value === false ? "off" : String(o.value)}
                  >
                    {o.value === false ? "Auto-refresh: Off" : `Every ${o.label}`}
                  </option>
                ))}
              </select>
            </label>
            {/* Shared-link theme — owner-only. Sets a palette that applies on
                the public /share/[token] view, regardless of the viewer's
                personal theme. Empty = the viewer keeps their own theme. */}
            {editing && layout && (
              <label
                className={cn(
                  "border-border bg-background inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-sm",
                  layout.theme && "border-primary text-primary",
                )}
                title="Theme used when someone opens this dashboard's shared link. Doesn't change your own view."
              >
                <span aria-hidden>🎨</span>
                <span className="sr-only">Shared-link theme</span>
                <select
                  value={layout.theme ?? ""}
                  onChange={(e) =>
                    writeLayout((l) => ({
                      ...l,
                      theme: e.target.value || undefined,
                    }))
                  }
                  className="bg-background cursor-pointer text-sm focus:outline-none"
                >
                  <option value="">Share theme: viewer&apos;s own</option>
                  {THEME_IDS.map((id) => (
                    <option key={id} value={id}>
                      Share theme: {THEME_META[id].name}
                    </option>
                  ))}
                </select>
              </label>
            )}
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
          label={
            refresh.isPending
              ? "Refreshing…"
              : refreshActive
                ? `Syncing ${refreshSynced}/${refreshTotal}…`
                : "Refresh data"
          }
          onClick={() => refresh.mutate({ raidTeamId: teamId })}
          disabled={refresh.isPending || refreshActive}
        />
        <ActionButton
          icon="🔗"
          label="Share"
          onClick={() => setOpenShare(true)}
          disabled={!dashboardId}
        />
      </div>

      {/* Refresh status — its own line so it never crowds the action bar
          buttons or the share UI. While the bulk job is running, render a
          live progress bar driven by `raidTeam.syncProgress`; once every
          tracked character's `lastSyncedAt` advances past the enqueue
          timestamp, the bar fills and the box shows "Up to date". */}
      {(refresh.data || refresh.error || refreshActive) && !refresh.isPending && (
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
          {refresh.error ? (
            `Refresh failed: ${refresh.error.message}. Try again in a moment.`
          ) : refresh.data && refresh.data.ok === false ? (
            refresh.data.reason === "no_members"
              ? "No active members to refresh."
              : "Refresh was rate-limited. Try again shortly."
          ) : refreshProgress ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3 tabular-nums">
                <span>
                  {refreshDone
                    ? `Up to date — ${refreshTotal}/${refreshTotal} synced`
                    : `Syncing characters from Battle.net + WCL…`}
                </span>
                <span className="text-foreground font-medium">
                  {refreshSynced}/{refreshTotal}
                </span>
              </div>
              {/* Determinate bar; aria attrs make it screen-reader-friendly. */}
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={refreshTotal}
                aria-valuenow={refreshSynced}
                aria-label="Team refresh progress"
                className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
              >
                <div
                  className={cn(
                    "h-full transition-[width] duration-500 ease-out",
                    refreshDone ? "bg-emerald-500" : "bg-primary",
                  )}
                  style={{
                    width: `${
                      refreshTotal > 0
                        ? Math.round((refreshSynced / refreshTotal) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
          ) : null}
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
        ) : mobileMode ? (
          /* Modern mobile layout: a single-column stack of full-width
             widgets (what phones get automatically). On a desktop preview
             it renders inside a phone-width frame; editing offers ↑/↓
             reorder + height + remove instead of free 2D placement. */
          <div
            className={cn(
              "space-y-2",
              !isSmallScreen &&
                "border-border bg-muted/20 mx-auto w-full max-w-[430px] rounded-2xl border p-2",
            )}
          >
            {sortForMobileStack(activeTab.widgets).map((w, i, arr) => (
              <WidgetCell
                key={w.id}
                widget={w}
                raidTeamId={teamId}
                editing={editing}
                isMobile
                stacked
                onRemove={removeWidget}
                onResize={resizeWidget}
                onReorder={reorderWidget}
                reorderDisabled={{ up: i === 0, down: i === arr.length - 1 }}
              />
            ))}
          </div>
        ) : (
          <div
            className="grid gap-2"
            style={{
              gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
              gridAutoRows: `${ROW_HEIGHT_PX}px`,
              gridAutoFlow: "dense",
            }}
          >
            {previewWidgets.map((w) => (
              <WidgetCell
                key={w.id}
                widget={w}
                raidTeamId={teamId}
                editing={editing}
                isMobile={false}
                onRemove={removeWidget}
                onResize={resizeWidget}
                onMove={moveWidget}
                onMovePreview={onMovePreview}
                onResizePreview={onResizePreview}
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
        onAdd={addWidgets}
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
