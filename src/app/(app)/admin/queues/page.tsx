"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/trpc-client";

/**
 * Platform-admin queue inspector. Hidden behind ADMIN_USER_IDS; non-admins
 * see a generic NOT_FOUND because the router throws that to avoid leaking
 * the admin surface to discovery.
 */
export default function QueuesPage() {
  const [refreshTick, setRefreshTick] = useState(0);
  const status = api.admin.queueStatus.useQuery(
    { recentLimit: 10 },
    { refetchInterval: 10_000 },
  );
  const runs = api.admin.recentSyncRuns.useQuery(
    { limit: 25 },
    { refetchInterval: 10_000 },
  );

  if (status.error || runs.error) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>Not found</CardTitle>
            <CardDescription>
              {status.error?.message ?? runs.error?.message ?? "Unknown error"}
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-12">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Queue admin</h1>
          <p className="text-muted-foreground text-sm">
            BullMQ queues and recent SyncRuns. Auto-refreshes every 10s.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setRefreshTick((t) => t + 1);
            status.refetch();
            runs.refetch();
          }}
        >
          Refresh now ({refreshTick})
        </Button>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        {status.data?.queues.map((q) => (
          <Card key={q.name}>
            <CardHeader>
              <CardTitle className="text-base">{q.name}</CardTitle>
              <CardDescription className="text-xs">
                {(["waiting", "active", "completed", "failed", "delayed"] as const)
                  .map((k) => `${k}: ${q.counts[k] ?? 0}`)
                  .join(" · ")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-xs">
                {q.recent.length === 0 ? (
                  <li className="text-muted-foreground">No recent jobs.</li>
                ) : (
                  q.recent.map((j) => (
                    <li
                      key={j.id}
                      className="flex items-baseline justify-between gap-2"
                    >
                      <span className="truncate font-mono">
                        {j.id.slice(0, 8)} · {j.name}
                      </span>
                      <span
                        className={
                          j.status === "failed"
                            ? "text-destructive"
                            : "text-green-500"
                        }
                      >
                        {j.status}
                      </span>
                    </li>
                  ))
                )}
              </ul>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Recent SyncRuns</CardTitle>
          <CardDescription>
            The 25 most recent runs across all tiers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {runs.isPending ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : runs.data && runs.data.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Recent SyncRuns</caption>
                <thead>
                  <tr className="text-muted-foreground text-left text-xs uppercase">
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Tier
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Source
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Started
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Finished
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {runs.data.map((r) => (
                    <tr key={r.id}>
                      <td className="py-1.5 pr-3 font-mono">{r.tier}</td>
                      <td className="py-1.5 pr-3">{r.source}</td>
                      <td className="text-muted-foreground py-1.5 pr-3 text-xs">
                        {new Date(r.startedAt).toLocaleString()}
                      </td>
                      <td className="text-muted-foreground py-1.5 pr-3 text-xs">
                        {r.finishedAt
                          ? new Date(r.finishedAt).toLocaleString()
                          : "—"}
                      </td>
                      <td className="py-1.5 pr-3">
                        {r.ok ? (
                          <span className="text-green-500">ok</span>
                        ) : r.finishedAt ? (
                          <span
                            className="text-destructive"
                            title={r.errorMessage ?? undefined}
                          >
                            failed
                          </span>
                        ) : (
                          <span className="text-muted-foreground">running</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No runs yet.</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
