"use client";

import { Suspense, use, useState, type FormEvent } from "react";
import Link from "next/link";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

  const approve = api.guild.approveMember.useMutation({
    onSuccess: () => utils.guild.get.invalidate({ guildId }),
  });

  const triggerSync = api.guild.triggerManualSync.useMutation();

  const [teamName, setTeamName] = useState("");
  const createTeam = api.raidTeam.create.useMutation({
    onSuccess: () => {
      setTeamName("");
      utils.guild.get.invalidate({ guildId });
    },
  });
  const onCreateTeam = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!teamName.trim()) return;
    createTeam.mutate({ guildId, name: teamName.trim() });
  };

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

  const { guild, myRole, myStatus } = detail.data!;
  const isStaff = myRole === "OWNER" || myRole === "OFFICER";

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 space-y-8">
      <header>
        <Link
          href="/guild"
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          ← Guilds
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{guild.name}</h1>
        <p className="text-muted-foreground text-sm">
          {guild.region} · {guild.realmSlug} · {guild.faction} · {guild.claimStatus}
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          You are a {myRole.toLowerCase()} ({myStatus.toLowerCase()}).
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Roster sync</CardTitle>
          <CardDescription>
            Manual roster refresh pulls the live member list from Battle.net.
            Rate-limited to 1 per 5 minutes per guild.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={() => triggerSync.mutate({ guildId })}
            disabled={triggerSync.isPending}
          >
            {triggerSync.isPending ? "Queueing…" : "Refresh roster now"}
          </Button>
          {triggerSync.data && triggerSync.data.ok && (
            <p className="text-muted-foreground mt-2 text-sm">
              Queued. Job id: {triggerSync.data.jobId}
            </p>
          )}
          {triggerSync.error && (
            <p className="text-destructive mt-2 text-sm" role="alert">
              {triggerSync.error.message}
            </p>
          )}
        </CardContent>
      </Card>

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
                <li key={t.id} className="py-3">
                  <p className="font-medium">{t.name}</p>
                  <p className="text-muted-foreground text-xs">
                    {t._count.memberships} member
                    {t._count.memberships === 1 ? "" : "s"} · visibility{" "}
                    {t.visibility.toLowerCase()}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {isStaff && (
            <form
              onSubmit={onCreateTeam}
              className="space-y-3 rounded-md border border-border p-3"
            >
              <div className="space-y-2">
                <Label htmlFor="teamName">Create a raid team</Label>
                <Input
                  id="teamName"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="Eclipse Midnight"
                  minLength={2}
                  maxLength={60}
                  required
                />
              </div>
              {createTeam.error && (
                <p className="text-destructive text-sm" role="alert">
                  {createTeam.error.message}
                </p>
              )}
              <Button
                type="submit"
                size="sm"
                disabled={createTeam.isPending || !teamName.trim()}
              >
                {createTeam.isPending ? "Creating…" : "Create"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <WowauditConfigCard guildId={guildId} canEdit={isStaff} />
    </main>
  );
}
