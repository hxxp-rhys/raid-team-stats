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
  const [teamWclSource, setTeamWclSource] = useState("");
  const createTeam = api.raidTeam.create.useMutation({
    onSuccess: async (team) => {
      setTeamName("");
      setTeamWclSource("");
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
    createTeam.mutate({
      guildId,
      name: teamName.trim(),
      wclSource: teamWclSource.trim() || undefined,
    });
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
            <div className="space-y-2">
              <Label htmlFor="teamWclSource">
                Warcraft Logs source{" "}
                <span className="text-muted-foreground font-normal">
                  (optional — defaults to the guild&apos;s logs)
                </span>
              </Label>
              <Input
                id="teamWclSource"
                value={teamWclSource}
                onChange={(e) => setTeamWclSource(e.target.value)}
                placeholder="https://www.warcraftlogs.com/guild/id/123456"
                maxLength={300}
              />
              <p className="text-muted-foreground text-xs">
                Only set this if the team logs under its own WCL guild. You
                can change it any time below.
              </p>
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

      {guild.raidTeams.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Warcraft Logs sources</CardTitle>
            <CardDescription>
              Each team&apos;s dashboards read exactly one log source. The
              default is the guild&apos;s own logs; override it for teams
              that log under a separate WCL guild. Changing a source clears
              the old source&apos;s pull data before the new logs are
              fetched.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {guild.raidTeams.map((t) => (
              <TeamWclSourceRow
                key={t.id}
                guildId={guildId}
                team={{
                  id: t.id,
                  name: t.name,
                  wclGuildId: t.wclGuildId,
                  wclGuildName: t.wclGuildName,
                }}
              />
            ))}
          </CardContent>
        </Card>
      )}

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
 * One team's WCL log-source row: shows the current source and an editor
 * with a verify-then-save flow — the preview mutation resolves the id and
 * reports roster overlap so a typo'd id can't be saved blind. The server
 * enforces LEADER on both mutations.
 */
function TeamWclSourceRow({
  guildId,
  team,
}: {
  guildId: string;
  team: {
    id: string;
    name: string;
    wclGuildId: number | null;
    wclGuildName: string | null;
  };
}) {
  const utils = api.useUtils();
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState("");
  const preview = api.raidTeam.previewWclSource.useMutation();
  const save = api.raidTeam.setWclSource.useMutation({
    onSuccess: async () => {
      setEditing(false);
      setSource("");
      preview.reset();
      await utils.guild.get.invalidate({ guildId });
    },
  });

  const currentLabel =
    team.wclGuildId != null
      ? `${team.wclGuildName ?? "WCL guild"} (#${team.wclGuildId})`
      : "Guild logs (default)";

  return (
    <div className="border-border rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{team.name}</p>
          <p className="text-muted-foreground text-xs">{currentLabel}</p>
        </div>
        <div className="flex gap-2">
          {team.wclGuildId != null && !editing && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={save.isPending}
              onClick={() => save.mutate({ raidTeamId: team.id, source: null })}
            >
              {save.isPending ? "Reverting…" : "Use guild logs"}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing((v) => !v);
              preview.reset();
              save.reset();
            }}
          >
            {editing ? "Cancel" : "Change"}
          </Button>
        </div>
      </div>

      {editing && (
        <div className="mt-3 space-y-2">
          <Input
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              preview.reset();
            }}
            placeholder="https://www.warcraftlogs.com/guild/id/123456"
            maxLength={300}
            aria-label={`Warcraft Logs source for ${team.name}`}
          />
          {preview.data ? (
            <div className="text-xs">
              <p>
                Resolved:{" "}
                <span className="font-medium">
                  {preview.data.name ?? "Unnamed guild"}
                </span>
                {preview.data.server ? ` — ${preview.data.server}` : ""} (#
                {preview.data.wclGuildId})
              </p>
              {preview.data.rosterOverlap != null ? (
                <p
                  className={
                    preview.data.rosterOverlap === 0
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {preview.data.rosterOverlap} of {preview.data.rosterSize}{" "}
                  roster member
                  {preview.data.rosterSize === 1 ? "" : "s"} appear in its
                  newest report
                  {preview.data.sampleReportTitle
                    ? ` (“${preview.data.sampleReportTitle}”)`
                    : ""}
                  {preview.data.rosterOverlap === 0 &&
                    " — are you sure this is the right guild?"}
                </p>
              ) : (
                <p className="text-muted-foreground">
                  No recent reports to cross-check the roster against.
                </p>
              )}
              <Button
                type="button"
                size="sm"
                className="mt-2"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({ raidTeamId: team.id, source: source.trim() })
                }
              >
                {save.isPending ? "Saving…" : "Save source"}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={preview.isPending || !source.trim()}
              onClick={() =>
                preview.mutate({ raidTeamId: team.id, source: source.trim() })
              }
            >
              {preview.isPending ? "Checking…" : "Verify"}
            </Button>
          )}
          {(preview.error ?? save.error) && (
            <p className="text-destructive text-xs" role="alert">
              {(preview.error ?? save.error)?.message}
            </p>
          )}
        </div>
      )}
    </div>
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
