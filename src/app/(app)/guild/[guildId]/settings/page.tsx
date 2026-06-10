"use client";

import { Suspense, use, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Params = Promise<{ guildId: string }>;

/**
 * Guild settings page. Access is gated by the `guild.canManageSettings`
 * query (platform admin · guild OWNER · raid-team LEADER/CO_LEADER of
 * any team in this guild). Raid-team creation lives here so the listing
 * surface on the guild page stays read-only for non-managers.
 */
export default function GuildSettingsPage({ params }: { params: Params }) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-3xl px-4 py-12">
          <p className="text-muted-foreground text-sm">Loading…</p>
        </main>
      }
    >
      <GuildSettingsInner params={params} />
    </Suspense>
  );
}

function GuildSettingsInner({ params }: { params: Params }) {
  const { guildId } = use(params);
  const router = useRouter();
  const utils = api.useUtils();

  const detail = api.guild.get.useQuery({ guildId });
  const access = api.guild.canManageSettings.useQuery({ guildId });

  const [teamName, setTeamName] = useState("");
  const createTeam = api.raidTeam.create.useMutation({
    onSuccess: async (team) => {
      setTeamName("");
      await utils.guild.get.invalidate({ guildId });
      // Drop the user straight into the new team's dashboard list so they
      // can add widgets without hunting through the UI.
      router.push(
        `/guild/${guildId}/team/${team.id}/dashboard` as Route,
      );
    },
  });
  const onCreateTeam = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!teamName.trim()) return;
    createTeam.mutate({ guildId, name: teamName.trim() });
  };

  if (detail.isPending || access.isPending) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>Guild not found</CardTitle>
            <CardDescription>
              {detail.error?.message ?? "Unknown error"}
            </CardDescription>
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
  if (!access.data?.canManage) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>Not authorised</CardTitle>
            <CardDescription>
              Guild settings are available to guild owners, raid-team
              leaders and co-leaders, and platform admins.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Link
              href={`/guild/${guildId}` as Route}
              className="text-primary text-sm underline-offset-4 hover:underline"
            >
              ← Back to guild
            </Link>
          </CardFooter>
        </Card>
      </main>
    );
  }

  const { guild } = detail.data;
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-12">
      <header>
        <Link
          href={`/guild/${guildId}` as Route}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          ← {guild.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Guild settings
        </h1>
        <p className="text-muted-foreground text-sm">
          Manage raid teams and integrations for {guild.name}.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Create a raid team</CardTitle>
          <CardDescription>
            Each raid team has its own dashboards, members, and refresh
            schedule.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={onCreateTeam}
            className="border-border space-y-3 rounded-md border p-3"
          >
            <div className="space-y-2">
              <Label htmlFor="teamName">Team name</Label>
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
        </CardContent>
      </Card>
    </main>
  );
}
