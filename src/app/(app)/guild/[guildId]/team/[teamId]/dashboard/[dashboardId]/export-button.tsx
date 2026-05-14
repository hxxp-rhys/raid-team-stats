"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/trpc-client";

/**
 * Triggers a server-side CSV build, then drops the bytes into a blob and
 * forces a download via a synthetic anchor click. The mutation is rate-
 * limited at the tRPC layer (per-user) and audited.
 */
export function ExportCsvButton({ dashboardId }: { dashboardId: string }) {
  const [error, setError] = useState<string | null>(null);
  const exportCsv = api.dashboard.exportCsv.useMutation({
    onSuccess: (data) => {
      setError(null);
      const blob = new Blob([data.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = data.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    },
    onError: (err) => setError(err.message),
  });

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={exportCsv.isPending}
        onClick={() => exportCsv.mutate({ dashboardId })}
      >
        {exportCsv.isPending ? "Exporting…" : "Export CSV"}
      </Button>
      {error && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
