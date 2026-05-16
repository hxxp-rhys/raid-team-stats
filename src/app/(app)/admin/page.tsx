"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/trpc-client";

export default function AdminOverviewPage() {
  const overview = api.admin.overview.useQuery();

  return (
    <section className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Users" value={overview.data?.users} />
        <Stat label="Admins" value={overview.data?.admins} />
        <Stat label="Guilds" value={overview.data?.guilds} />
        <Stat label="Raid teams" value={overview.data?.raidTeams} />
        <Stat label="Sync runs (24h)" value={overview.data?.syncRuns24h} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What lives here</CardTitle>
          <CardDescription>
            The admin surface is intentionally minimal. Use the tabs above to
            dig in.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-2 text-sm">
          <p>
            <strong className="text-foreground">Users</strong> — search/filter
            the user base and promote or demote platform admins. Filter by WoW
            region, realm, or guild membership.
          </p>
          <p>
            <strong className="text-foreground">Guilds</strong> — every guild
            seen by the platform, with claim status and member counts.
          </p>
          <p>
            <strong className="text-foreground">Audit log</strong> — the last
            50 security-relevant events, newest first.
          </p>
          <p>
            <strong className="text-foreground">Queues</strong> — BullMQ status
            and recent sync runs for ops triage.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="text-xs uppercase tracking-wide">
          {label}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">
          {value ?? "—"}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}
