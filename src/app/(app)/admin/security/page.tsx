"use client";

import { api } from "@/lib/trpc-client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const REFRESH_MS = 30_000;

function Stat({
  label,
  value,
  alert,
}: {
  label: string;
  value: number | string;
  alert?: boolean;
}) {
  return (
    <div
      className={
        alert
          ? "rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
          : "border-border rounded-lg border p-3"
      }
    >
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

const EVENT_LABEL = (e: string) => e.replace(/_/g, " ").toLowerCase();

export default function AdminSecurityPage() {
  const overview = api.security.overview.useQuery(undefined, {
    refetchInterval: REFRESH_MS,
  });
  const events = api.security.recentEvents.useQuery(
    { limit: 60 },
    { refetchInterval: REFRESH_MS },
  );
  const o = overview.data;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Security</h2>
        <p className="text-muted-foreground text-sm">
          Concerning activity from the audit log — failed logins, denied access,
          rate-limit breaches, and privileged actions. Auto-refreshes every 30s.
          Thresholds are configured in Settings.
        </p>
      </div>

      {o?.loginFailureSpike.alerting && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
          ⚠ Login-failure spike: {o.loginFailureSpike.count} failures in the last{" "}
          {o.loginFailureSpike.windowMinutes} min (threshold{" "}
          {o.loginFailureSpike.threshold}). Possible credential stuffing /
          brute force.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Last 24 hours</CardTitle>
          <CardDescription>
            {overview.isPending ? "Loading…" : "Counts of security-relevant events."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat
              label="Login failures"
              value={o?.loginFailures24 ?? "—"}
              alert={o?.loginFailureSpike.alerting}
            />
            <Stat label="Access denied" value={o?.authzDenied24 ?? "—"} />
            <Stat label="Rate-limited" value={o?.rateLimited24 ?? "—"} />
            <Stat label="MFA disabled" value={o?.mfaDisabled24 ?? "—"} />
            <Stat label="Privileged actions" value={o?.privileged24 ?? "—"} />
            <Stat label="Password resets" value={o?.pwResetReq24 ?? "—"} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent security events</CardTitle>
          <CardDescription>
            Newest first. Source is a daily-salted IP hash prefix (same source =
            same value, same day) — never a raw IP.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {events.isPending ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : (events.data?.length ?? 0) === 0 ? (
            <p className="text-muted-foreground text-sm">
              No security events recorded yet.
            </p>
          ) : (
            <ul className="divide-border divide-y text-sm">
              {events.data!.map((e) => {
                const reason =
                  e.metadata && typeof e.metadata === "object"
                    ? (e.metadata as Record<string, unknown>).reason
                    : undefined;
                return (
                  <li
                    key={e.id}
                    className="flex items-baseline justify-between gap-3 py-1.5"
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{EVENT_LABEL(e.event)}</span>
                      {typeof reason === "string" && (
                        <span className="text-muted-foreground"> · {reason}</span>
                      )}
                      <span className="text-muted-foreground block text-xs">
                        {e.actor}
                        {e.subjectType ? ` · ${e.subjectType}` : ""}
                        {e.ipHashShort ? ` · ip:${e.ipHashShort}` : ""}
                      </span>
                    </span>
                    <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                      {new Date(e.createdAt).toLocaleString()}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
