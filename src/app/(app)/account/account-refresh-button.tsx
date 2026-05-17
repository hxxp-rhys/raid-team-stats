"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/trpc-client";

/**
 * Header action on the Account page: re-syncs the signed-in user's own
 * characters (Tier-A: Blizzard + WCL + Raider.IO). Server-side it's
 * rate-limited to once per 10 minutes per user.
 */
export function AccountRefreshButton() {
  const utils = api.useUtils();
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = api.account.refreshMyData.useMutation({
    onSuccess: (data) => {
      if (data.ok) {
        setMsg(
          `Queued ${data.enqueued} character ${
            data.enqueued === 1 ? "sync" : "syncs"
          } — your data updates shortly.`,
        );
        void utils.account.uploadStatus.invalidate();
      } else {
        setMsg("No characters linked yet — link Battle.net first.");
      }
    },
    onError: (e) => setMsg(e.message),
  });

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
      {msg && (
        <span
          className="text-muted-foreground max-w-[15rem] text-right text-xs"
          role="status"
          aria-live="polite"
        >
          {msg}
        </span>
      )}
    </div>
  );
}
