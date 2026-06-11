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
import { DestructiveConfirmCard } from "@/components/ui/destructive-confirm-card";

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

  const { guild, myRole, isAdmin } = detail.data;
  // Guild deletion is OWNER-only (or platform admin) — destroys ALL raid
  // teams, dashboards, memberships, and character links under it.
  const canDeleteGuild = myRole === "OWNER" || isAdmin === true;
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

      {/* Danger zone — destructive removals. The server still enforces
          per-team / per-guild role checks; these UIs are gated to the
          surfaces the typical authorised user expects to see. */}
      {(guild.raidTeams.length > 0 || canDeleteGuild) && (
        <section className="space-y-3">
          <header>
            <h2 className="text-destructive text-lg font-semibold tracking-tight">
              Danger zone
            </h2>
            <p className="text-muted-foreground text-sm">
              These actions permanently remove data and can&apos;t be undone.
            </p>
          </header>

          {guild.raidTeams.map((t) => (
            <RemoveTeamSection
              key={t.id}
              guildId={guildId}
              team={{
                id: t.id,
                name: t.name,
                memberCount: t._count.memberships,
              }}
            />
          ))}

          {canDeleteGuild && (
            <RemoveGuildSection
              guildId={guildId}
              guildName={guild.name}
              raidTeamCount={guild.raidTeams.length}
            />
          )}
        </section>
      )}
    </main>
  );
}

/**
 * Inline section that renders one DestructiveConfirmCard per team. Each
 * instance owns its own mutation hook so two cards can be in flight
 * simultaneously without conflicting state.
 */
function RemoveTeamSection({
  guildId,
  team,
}: {
  guildId: string;
  team: { id: string; name: string; memberCount: number };
}) {
  const utils = api.useUtils();
  const del = api.raidTeam.delete.useMutation({
    onSuccess: async () => {
      await utils.guild.get.invalidate({ guildId });
    },
  });
  return (
    <DestructiveConfirmCard
      title={`Delete "${team.name}"`}
      description={
        <>
          Permanently removes the raid team, its dashboards, and its{" "}
          {team.memberCount} member
          {team.memberCount === 1 ? "" : "s"}. Character snapshots and the
          underlying guild memberships are kept.
        </>
      }
      expectedConfirm={team.name}
      onConfirm={() =>
        del.mutate({ raidTeamId: team.id, confirmName: team.name })
      }
      isPending={del.isPending}
      errorMessage={del.error?.message ?? null}
      buttonLabel={`Delete "${team.name}"`}
      submittingLabel="Deleting…"
    />
  );
}

/**
 * Bottom-of-page guild deletion. Navigation home happens on success so the
 * user doesn't end up on a 404'd guild detail page.
 */
function RemoveGuildSection({
  guildId,
  guildName,
  raidTeamCount,
}: {
  guildId: string;
  guildName: string;
  raidTeamCount: number;
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const del = api.guild.delete.useMutation({
    onSuccess: async () => {
      // Invalidate the user's guild list then leave the now-dead page.
      await utils.guild.myGuilds.invalidate();
      router.push("/guild" as Route);
    },
  });
  return (
    <DestructiveConfirmCard
      title={`Delete "${guildName}"`}
      description={
        <>
          Permanently removes the guild and{" "}
          <span className="font-semibold">
            every raid team in it
          </span>{" "}
          ({raidTeamCount} team
          {raidTeamCount === 1 ? "" : "s"}), along with their dashboards,
          memberships, and character links. Character data itself is kept.
          Only the guild owner (or a platform admin) can do this.
        </>
      }
      expectedConfirm={guildName}
      onConfirm={() =>
        del.mutate({ guildId, confirmName: guildName })
      }
      isPending={del.isPending}
      errorMessage={del.error?.message ?? null}
      buttonLabel={`Delete "${guildName}"`}
      submittingLabel="Deleting…"
      helper="This deletes every raid team, dashboard, and membership under the guild. There is no undo."
    />
  );
}
