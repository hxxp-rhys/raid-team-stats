"use client";

import { Suspense, use, useEffect, useState } from "react";

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/trpc-client";
import { setShareTokenHeader } from "@/lib/share-token-header";
import {
  DEFAULT_WIDGET_COLS,
  DEFAULT_WIDGET_ROWS,
  DESKTOP_GRID_COLS,
  ROW_HEIGHT_PX,
  parseLayout,
  resolveDefaultTabId,
} from "@/lib/widgets/types";
import { autoPlaceWidgets } from "@/lib/widgets/layout-engine";
import {
  sortForMobileStack,
  useIsMobile,
} from "@/lib/widgets/use-is-mobile";

// Same auto-placement the editor renders with, so the shared view never shows
// the CSS auto-flow arrangement for widgets the owner never explicitly placed.
const SHARE_DEFAULTS = { cols: DEFAULT_WIDGET_COLS, rows: DEFAULT_WIDGET_ROWS };
import { isLightTheme, isValidTheme } from "@/lib/theme";
import { WidgetCell } from "@/app/(app)/guild/[guildId]/team/[teamId]/widget-cell";

type Params = Promise<{ token: string }>;

/**
 * Share-link dashboard view. The server-side resolver verifies the token's
 * signature; access is then EITHER a signed-in guild member OR — when the
 * dashboard's owners flipped "publicly viewable" on — anyone holding the
 * link (read-only; the token rides every data request as x-share-token).
 *
 * Desktop renders the SAME grid + WidgetCell (read-only) the control panel
 * uses, so the shared layout is pixel-identical to what the editor saved.
 * Phone-sized viewports render the dashboard's mobile layout (or a derived
 * single-column stack when none was authored).
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
  // Park the token for the tRPC client BEFORE any query fires, so an
  // anonymous public-share viewer's data requests carry x-share-token.
  // A module-var write during render is idempotent; cleared on unmount.
  setShareTokenHeader(token);
  useEffect(() => {
    setShareTokenHeader(token);
    return () => setShareTokenHeader(null);
  }, [token]);

  const q = api.dashboard.getByShareToken.useQuery({ token });
  // Hooks must run on every render path — keep above early returns.
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const isMobile = useIsMobile();

  // Dashboard-exclusive theme: if the owner set one, apply it to <html> for
  // the duration of this shared view, then restore the visitor's own theme
  // on unmount. Computed above the early returns so the effect's hook order
  // stays stable across loading/error/data renders.
  const dashTheme = q.data
    ? parseLayout(q.data.dashboard.layout).theme
    : undefined;
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
  // Phone-sized viewports get the dashboard's mobile layout when one was
  // authored; otherwise the desktop tabs render as a derived single-column
  // stack. Desktop keeps the authored grid.
  const tabsArr =
    isMobile && layout.mobileTabs && layout.mobileTabs.length > 0
      ? layout.mobileTabs
      : layout.tabs;
  const totalWidgets = tabsArr.reduce((s, t) => s + t.widgets.length, 0);
  const selectedTabId = activeTabId ?? resolveDefaultTabId(layout);
  const activeTab =
    tabsArr.find((t) => t.id === selectedTabId) ?? tabsArr[0];
  const desktopWidgets = autoPlaceWidgets(
    activeTab?.widgets ?? [],
    DESKTOP_GRID_COLS,
    SHARE_DEFAULTS,
  );
  const expires = expiresAt ? new Date(expiresAt) : null;

  return (
    <main className="mx-auto max-w-[1400px] space-y-4 px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {dashboard.name}
        </h1>
        <p className="text-muted-foreground text-sm">
          Shared view · {totalWidgets} widget
          {totalWidgets === 1 ? "" : "s"} ·{" "}
          {expires
            ? `expires ${expires.toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}`
            : "never expires"}
        </p>
      </header>

      {tabsArr.length > 1 && (
        <div className="border-b border-border" role="tablist">
          <div className="flex flex-wrap gap-1">
            {tabsArr.map((t) => {
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
      ) : isMobile ? (
        <div className="space-y-2">
          {sortForMobileStack(activeTab?.widgets ?? []).map((w) => (
            <WidgetCell
              key={w.id}
              widget={w}
              raidTeamId={dashboard.raidTeamId}
              editing={false}
              isMobile
              stacked
            />
          ))}
        </div>
      ) : (
        <div
          className="grid gap-2"
          style={{
            gridTemplateColumns: `repeat(${DESKTOP_GRID_COLS}, minmax(0, 1fr))`,
            gridAutoRows: `${ROW_HEIGHT_PX}px`,
            gridAutoFlow: "dense",
          }}
        >
          {desktopWidgets.map((w) => (
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
