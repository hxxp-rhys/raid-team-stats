"use client";

import { useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/trpc-client";

const EVENT_OPTIONS = [
  "",
  "AUTH_LOGIN_SUCCESS",
  "AUTH_LOGIN_FAILURE",
  "AUTH_BATTLENET_LINKED",
  "AUTH_MFA_ENABLED",
  "GUILD_CLAIMED",
  "GUILD_ROLE_CHANGED",
  "MEMBER_APPROVED",
  "MEMBER_DEPARTED",
  "RAID_TEAM_CREATED",
  "RAID_TEAM_SETTINGS_UPDATED",
  "ADMIN_USER_PROMOTED",
  "ADMIN_USER_DEMOTED",
  "SYNC_TRIGGERED",
  "SYNC_FAILED",
  "RATE_LIMIT_EXCEEDED",
  "AUTHZ_DENIED",
] as const;

export default function AdminAuditPage() {
  const [event, setEvent] = useState<string>("");
  const audit = api.admin.recentAudit.useQuery({
    limit: 100,
    event: event || undefined,
  });

  return (
    <section className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Filter</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="audit-event">Event</Label>
            <select
              id="audit-event"
              value={event}
              onChange={(e) => setEvent(e.target.value)}
              className="border-border bg-background h-9 w-full rounded-md border px-2 text-sm"
            >
              {EVENT_OPTIONS.map((e) => (
                <option key={e || "all"} value={e}>
                  {e || "All events"}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent events</CardTitle>
          <CardDescription>
            Last {audit.data?.length ?? 0} of up to 100. Newest first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {audit.isPending ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : audit.error ? (
            <p className="text-destructive text-sm" role="alert">
              {audit.error.message}
            </p>
          ) : audit.data && audit.data.length === 0 ? (
            <p className="text-muted-foreground text-sm">No events.</p>
          ) : (
            <ul className="space-y-2">
              {audit.data?.map((row) => (
                <li
                  key={String(row.id)}
                  className="border-border bg-muted/30 rounded-md border p-2 text-xs"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-mono text-sm">{row.event}</span>
                    <span className="text-muted-foreground">
                      {new Date(row.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-muted-foreground">
                    Actor: {row.actor}
                    {row.subjectType ? (
                      <>
                        {" · "}Subject: {row.subjectType}
                        {row.subject ? ` — ${row.subject}` : ""}
                      </>
                    ) : null}
                  </p>
                  {row.metadata && Object.keys(row.metadata as object).length > 0 && (
                    <pre className="text-muted-foreground mt-1 max-h-32 overflow-auto text-[10px]">
                      {JSON.stringify(row.metadata, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
