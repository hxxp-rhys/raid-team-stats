"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/trpc-client";

export function ShareLinkButton({ dashboardId }: { dashboardId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = api.dashboard.createShareLink.useMutation({
    onSuccess: (data) => {
      setUrl(data.url);
      setExpiresAt(new Date(data.expiresAt));
      setCopied(false);
      setError(null);
    },
    onError: (err) => setError(err.message),
  });

  const onCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context); fall through silently.
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={create.isPending}
        onClick={() => create.mutate({ dashboardId })}
      >
        {create.isPending ? "Generating…" : url ? "New link" : "Share link"}
      </Button>
      {url && (
        <div className="bg-muted/30 mt-2 max-w-md rounded-md border p-2 text-xs">
          <p className="text-muted-foreground mb-1">
            Expires {expiresAt?.toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
            . Anyone in your guild who signs in can open it.
          </p>
          <div className="flex items-center gap-2">
            <code className="bg-background flex-1 truncate rounded px-2 py-1">
              {url}
            </code>
            <Button size="xs" variant="outline" onClick={onCopy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
