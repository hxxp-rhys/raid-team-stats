"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/trpc-client";

// Stable identity for the disabled-query placeholder so the query key
// doesn't churn while no refresh is in flight.
const EPOCH = new Date(0);

/**
 * Header action on the Account page: re-syncs the signed-in user's own
 * characters (Tier-A: Blizzard + WCL + Raider.IO) and shows a live
 * "synced X/Y characters" status so they know how soon their profile
 * will be current. Server-side it's rate-limited to once / 10 min per
 * user (platform admins are exempt).
 */
export function AccountRefreshButton() {
  const utils = api.useUtils();
  const [progress, setProgress] = useState<{
    since: Date;
    total: number;
  } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = api.account.refreshMyData.useMutation({
    onSuccess: (data) => {
      if (data.ok && data.enqueued > 0) {
        setMsg(null);
        setProgress({ since: data.at, total: data.enqueued });
        void utils.account.uploadStatus.invalidate();
      } else {
        setProgress(null);
        setMsg("No characters linked yet — link Battle.net first.");
      }
    },
    onError: (e) => {
      setProgress(null);
      setMsg(e.message);
    },
  });

  // Poll synced/total while a refresh is in flight; stop once complete.
  const sync = api.account.refreshProgress.useQuery(
    { since: progress?.since ?? EPOCH },
    {
      enabled: progress != null,
      refetchInterval: (query) => {
        const d = query.state.data;
        return d && d.synced >= d.total ? false : 2000;
      },
    },
  );

  const synced = progress
    ? Math.min(sync.data?.synced ?? 0, progress.total)
    : 0;
  const done = progress != null && synced >= progress.total;

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={refresh.isPending}
        onClick={() => {
          setMsg(null);
          refresh.mutate();
        }}
      >
        {refresh.isPending ? "Refreshing…" : "Refresh"}
      </Button>

      {progress ? (
        <span
          className="text-muted-foreground max-w-[16rem] text-right text-xs tabular-nums"
          role="status"
          aria-live="polite"
        >
          {done
            ? `Up to date — ${progress.total}/${progress.total} synced`
            : `Updating your data… ${synced}/${progress.total} characters`}
        </span>
      ) : (
        msg && (
          <span
            className="text-muted-foreground max-w-[16rem] text-right text-xs"
            role="status"
            aria-live="polite"
          >
            {msg}
          </span>
        )
      )}
    </div>
  );
}
