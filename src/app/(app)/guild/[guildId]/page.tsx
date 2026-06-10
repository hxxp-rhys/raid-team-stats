"use client";

import { Suspense, use, useState } from "react";
import Link from "next/link";
import type { Route } from "next";

import { api } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { WowauditConfigCard } from "./wowaudit-config";

type Params = Promise<{ guildId: string }>;

/**
 * Page wrapper. With Next 16's cacheComponents, components that call `use()`
 * on a request-time promise must sit inside a Suspense boundary so the
 * static-shell prerender can produce HTML during build.
 */
export default function GuildDetailPage({ params }: { params: Params }) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-3xl px-4 py-12">
          <p className="text-muted-foreground text-sm">Loading…</p>
        </main>
      }
    >
      <GuildDetailInner params={params} />
    </Suspense>
  );
}

function GuildDetailInner({ params }: { params: Params }) {
  const { guildId } = use(params);

  const detail = api.guild.get.useQuery({ guildId });
  const utils = api.useUtils();
  // Strictly-scoped "should we render the Settings link?" — owner + RT
  // leaders/co-leaders + platform admin. Server-side resolver in guild.ts.
  const settingsAccess = api.guild.canManageSettings.useQuery({ guildId });

  const approve = api.guild.approveMember.useMutation({
    onSuccess: () => utils.guild.get.invalidate({ guildId }),
  });

  // Job id of the currently-running manual sync (if any). Polling key for
  // RefreshRosterButton — null when no run is in flight.
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const triggerSync = api.guild.triggerManualSync.useMutation({
    onSuccess: (res) => {
      if (res.ok) setSyncJobId(res.jobId);
    },
  });

  if (detail.isPending) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
    );
  }
  if (detail.error) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>Guild not found</CardTitle>
            <CardDescription>{detail.error.message}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Link
              href="/guild"
              className="text-primary text-sm underline-offset-4 hover:underline"
            >
              ← Back to guilds
            </Link>
          </CardFooter>
        </Card>
      </main>
    );
  }

  const { guild, myRole, myStatus, isAdmin } = detail.data!;
  const isStaff = myRole === "OWNER" || myRole === "OFFICER" || isAdmin === true;

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/guild"
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            ← Guilds
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {guild.name}
          </h1>
          <p className="text-muted-foreground text-sm">
            {guild.region} · {guild.realmSlug} · {guild.faction} ·{" "}
            {guild.claimStatus}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            You are a {myRole.toLowerCase()} ({myStatus.toLowerCase()}).
          </p>
        </div>
        {/* Settings link — only visible to OWNER / RT-LEADER / RT-CO_LEADER /
            platform admin (server-resolved via guild.canManageSettings). */}
        {settingsAccess.data?.canManage && (
          <Link
            href={`/guild/${guildId}/settings` as Route}
            className="border-border bg-background hover:bg-muted shrink-0 inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors"
          >
            Settings
          </Link>
        )}
      </header>

      {isStaff && (
        <Card>
          <CardHeader>
            <CardTitle>Roster sync</CardTitle>
            <CardDescription>
              Manual roster refresh pulls the live member list from Battle.net.
              Rate-limited to 1 per 5 minutes per guild. To let raid-team
              members refresh their own stats, add the{" "}
              <em>Data refresh</em> widget to a team dashboard.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RefreshRosterButton
              guildId={guildId}
              jobId={syncJobId}
              onClickRefresh={() => triggerSync.mutate({ guildId })}
              isPending={triggerSync.isPending}
              triggerError={triggerSync.error?.message ?? null}
            />
            {triggerSync.error && (
              <p className="text-destructive mt-2 text-sm" role="alert">
                {triggerSync.error.message}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            {guild.memberships.length} member
            {guild.memberships.length === 1 ? "" : "s"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {guild.memberships.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between gap-3 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">{m.user.displayName ?? m.user.email}</p>
                  <p className="text-muted-foreground text-xs">
                    {m.role} · {m.status}
                  </p>
                </div>
                {isStaff && m.status === "PENDING" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => approve.mutate({ guildId, userId: m.user.id })}
                    disabled={approve.isPending}
                  >
                    Approve
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Raid teams</CardTitle>
          <CardDescription>
            {guild.raidTeams.length === 0
              ? "No teams yet."
              : `${guild.raidTeams.length} team${guild.raidTeams.length === 1 ? "" : "s"}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {guild.raidTeams.length > 0 && (
            <ul className="divide-y divide-border">
              {guild.raidTeams.map((t) => (
                <li key={t.id}>
                  <Link
                    href={{ pathname: `/guild/${guildId}/team/${t.id}` }}
                    className="hover:bg-muted block rounded-md py-3 px-2 -mx-2 transition-colors"
                  >
                    <p className="font-medium">{t.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {t._count.memberships} member
                      {t._count.memberships === 1 ? "" : "s"} · visibility{" "}
                      {t.visibility.toLowerCase()}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {settingsAccess.data?.canManage && guild.raidTeams.length === 0 && (
            <p className="text-muted-foreground text-xs">
              Create a team from{" "}
              <Link
                href={`/guild/${guildId}/settings` as Route}
                className="text-primary underline-offset-4 hover:underline"
              >
                Settings
              </Link>
              .
            </p>
          )}
        </CardContent>
      </Card>

      <WowauditConfigCard guildId={guildId} canEdit={isStaff} />
    </main>
  );
}

/**
 * Refresh Roster button with live progress. While a job is in flight the
 * button is disabled and the label reflects the current BullMQ state
 * (Queued → Running → Done/Failed). Polls every 2s while pending/active.
 */
function RefreshRosterButton({
  guildId,
  jobId,
  onClickRefresh,
  isPending,
  triggerError,
}: {
  guildId: string;
  jobId: string | null;
  onClickRefresh: () => void;
  isPending: boolean;
  triggerError: string | null;
}) {
  const status = api.guild.manualSyncStatus.useQuery(
    { guildId, jobId: jobId ?? "" },
    {
      enabled: !!jobId,
      // Stop polling once the job has reached a terminal state. The query
      // re-enables when a new jobId arrives (next click).
      refetchInterval: (q) => {
        const s = q.state.data?.state;
        if (!s) return 2000;
        return s === "completed" || s === "failed" || s === "unknown"
          ? false
          : 2000;
      },
      refetchOnWindowFocus: false,
    },
  );

  // Render label + progress message based on current state.
  let label = "Refresh Roster";
  let progress: string | null = null;
  if (isPending) {
    label = "Queueing…";
  } else if (jobId && status.data) {
    const s = status.data.state;
    if (s === "waiting" || s === "delayed" || s === "paused") {
      label = "Refreshing…";
      progress = "Waiting for worker to pick up the job…";
    } else if (s === "active") {
      label = "Refreshing…";
      progress = "Fetching roster from Battle.net + matching characters…";
    } else if (s === "completed") {
      label = "Refresh Roster";
      const r =
        (status.data.returnValue as
          | {
              characters?: number;
              guildMatches?: number;
              autoClaims?: number;
            }
          | null
          | undefined) ?? null;
      progress = r
        ? `Done — ${r.characters ?? 0} characters processed, ${r.guildMatches ?? 0} guild link${
            (r.guildMatches ?? 0) === 1 ? "" : "s"
          } updated.`
        : "Done.";
    } else if (s === "failed") {
      label = "Refresh Roster";
      progress = `Failed: ${status.data.failedReason ?? "unknown error"}`;
    } else {
      label = "Refresh Roster";
    }
  }

  const inFlight =
    isPending ||
    (!!jobId &&
      status.data &&
      ["waiting", "delayed", "paused", "active"].includes(status.data.state));

  return (
    <div>
      <Button onClick={onClickRefresh} disabled={!!inFlight}>
        {label}
      </Button>
      {progress && (
        <p
          className={`mt-2 text-sm ${
            status.data?.state === "failed"
              ? "text-destructive"
              : "text-muted-foreground"
          }`}
          aria-live="polite"
          role="status"
        >
          {progress}
        </p>
      )}
      {!progress && !triggerError && jobId && (
        <p className="text-muted-foreground mt-2 text-xs">
          Job id: <span className="font-mono">{jobId.split("_")[2] ?? jobId}</span>
        </p>
      )}
    </div>
  );
}
