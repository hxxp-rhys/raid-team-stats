"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { api } from "@/lib/trpc-client";

/**
 * Share modal: view-only link to the dashboard (issued on demand, signed
 * token, 7-day TTL) with a copy button that flashes "Copied ✓".
 *
 * Viewer-refresh is NOT configured here — the "Data refresh" widget on the
 * dashboard is the single source of truth for who can refresh.
 *
 * The body is a child mounted only while the modal is open, so its local
 * state (link, copied flag) resets naturally on each open — no
 * reset-in-effect (avoids react-hooks/set-state-in-effect).
 */
export function ShareModal({
  open,
  onClose,
  dashboardId,
}: {
  open: boolean;
  onClose: () => void;
  dashboardId: string | null;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share dashboard"
      description="Generate a view-only link to this dashboard."
    >
      {open && <ShareBody dashboardId={dashboardId} />}
    </Modal>
  );
}

function ShareBody({ dashboardId }: { dashboardId: string | null }) {
  const utils = api.useUtils();
  const createShare = api.dashboard.createShareLink.useMutation();
  const settings = api.dashboard.shareSettings.useQuery(
    { dashboardId: dashboardId ?? "" },
    { enabled: !!dashboardId },
  );
  const setPublic = api.dashboard.setSharePublic.useMutation({
    onSuccess: () =>
      utils.dashboard.shareSettings.invalidate({
        dashboardId: dashboardId ?? "",
      }),
  });
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Tabs the link will expose. `null` = "all tabs" (the default, and the state
  // before the tab list loads); a Set = an explicit subset the creator picked.
  const [selectedTabs, setSelectedTabs] = useState<Set<string> | null>(null);
  const tabs = settings.data?.tabs ?? [];
  const toggleTab = (id: string) =>
    setSelectedTabs((cur) => {
      // First toggle seeds from "all tabs", then removes the clicked one.
      const base = cur ?? new Set(tabs.map((t) => t.id));
      const next = new Set(base);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const isTabOn = (id: string) => selectedTabs === null || selectedTabs.has(id);

  // Clear the "Copied ✓" indicator ~2s after a copy. setState here is inside
  // the timeout callback (allowed), not synchronously in the effect body.
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const generate = () => {
    if (!dashboardId) return;
    // Only constrain the link when the creator picked a STRICT subset; "all
    // tabs selected" (or none picked) issues an unscoped link (back-compat).
    const picked = tabs.filter((t) => isTabOn(t.id)).map((t) => t.id);
    const allowedTabIds =
      tabs.length > 0 && picked.length < tabs.length ? picked : undefined;
    createShare.mutate(
      { dashboardId, ttlDays: 7, allowedTabIds },
      { onSuccess: (r) => setShareUrl(r.url) },
    );
  };

  const noTabsSelected =
    tabs.length > 0 && tabs.every((t) => !isTabOn(t.id));

  const copy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      // Older browsers may not have clipboard permissions in non-HTTPS dev.
      // Fall back to a manual prompt so the URL is still grabable.
      window.prompt("Copy this link", shareUrl);
    }
  };

  return (
    <div className="space-y-5 text-sm">
      {!dashboardId ? (
        <p className="text-muted-foreground">
          Save the dashboard first — share links resolve by dashboard id.
        </p>
      ) : (
        <section className="space-y-2">
          <p className="font-medium">View-only link</p>
          {tabs.length > 1 && !shareUrl && (
            <div className="border-border space-y-1.5 rounded-md border p-2.5">
              <p className="text-xs font-medium">Tabs to share</p>
              <div className="space-y-1">
                {tabs.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={isTabOn(t.id)}
                      onChange={() => toggleTab(t.id)}
                    />
                    {t.name}
                  </label>
                ))}
              </div>
              <p className="text-muted-foreground text-xs">
                Unchecked tabs aren&apos;t reachable through this link.
              </p>
              {noTabsSelected && (
                <p className="text-destructive text-xs">Pick at least one tab.</p>
              )}
            </div>
          )}
          {!shareUrl ? (
            <Button
              size="sm"
              onClick={generate}
              disabled={createShare.isPending || noTabsSelected}
            >
              {createShare.isPending ? "Generating…" : "Generate link"}
            </Button>
          ) : (
            <div className="flex items-stretch gap-2">
              <input
                readOnly
                value={shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="bg-background border-border min-w-0 flex-1 truncate rounded-md border px-3 py-1.5 font-mono text-xs"
              />
              <Button
                size="sm"
                variant={copied ? "outline" : "default"}
                onClick={copy}
                aria-live="polite"
              >
                {copied ? "Copied ✓" : "Copy"}
              </Button>
            </div>
          )}
          {createShare.error && (
            <p className="text-destructive text-xs" role="alert">
              {createShare.error.message}
            </p>
          )}

          <label
            className="border-border flex cursor-pointer items-start gap-2 rounded-md border p-2.5"
            title="When on, anyone who has the link can view this dashboard read-only without signing in. Turning it off re-locks every outstanding link instantly."
          >
            <input
              type="checkbox"
              className="mt-0.5"
              checked={settings.data?.shareIsPublic ?? false}
              disabled={settings.isPending || setPublic.isPending}
              onChange={(e) =>
                dashboardId &&
                setPublic.mutate({
                  dashboardId,
                  isPublic: e.target.checked,
                })
              }
            />
            <span>
              <span className="font-medium">Publicly viewable</span>
              <span className="text-muted-foreground block text-xs">
                Anyone with the link can view, no sign-in required
                (read-only). This exposes the TEAM&apos;s stats — every
                member&apos;s gear, parses, vault and activity data, not
                just the widgets on this dashboard. Off: viewers must be
                signed-in guild members.
              </span>
            </span>
          </label>
          {setPublic.error && (
            <p className="text-destructive text-xs" role="alert">
              {setPublic.error.message}
            </p>
          )}

          <p className="text-muted-foreground text-xs">
            Links expire after{" "}
            {settings.data?.shareIsPublic
              ? "7 days. Anyone holding the link can view until then (or until you turn public viewing off)."
              : "7 days. The viewer has to be signed in and a member of the guild — share links route, they don't grant access."}
          </p>
        </section>
      )}
    </div>
  );
}
