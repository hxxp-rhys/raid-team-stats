"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";

import { api, type RouterOutputs } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DangerZoneModal } from "@/components/ui/danger-zone-modal";
import { DestructiveConfirmCard } from "@/components/ui/destructive-confirm-card";

type GuildDetail = RouterOutputs["guild"]["get"]["guild"];
type Team = GuildDetail["raidTeams"][number];

/**
 * Guild management sections, rendered at the bottom of the guild detail
 * page for users who pass `guild.canManageSettings` (guild OWNER, raid-team
 * LEADER/CO_LEADER, platform admin). The server still enforces per-action
 * roles — e.g. renaming team X requires LEADER on X — so a co-leader of one
 * team seeing another team's controls just gets a clean error.
 */
export function GuildManageSections({
  guildId,
  guild,
  canDeleteGuild,
}: {
  guildId: string;
  guild: GuildDetail;
  canDeleteGuild: boolean;
}) {
  return (
    <>
      <CreateTeamCard guildId={guildId} />

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
              <TeamWclSourceRow key={t.id} guildId={guildId} team={t} />
            ))}
          </CardContent>
        </Card>
      )}

      {guild.raidTeams.length > 0 && (
        <section className="space-y-3">
          <header>
            <h2 className="text-lg font-semibold tracking-tight">
              Team management
            </h2>
            <p className="text-muted-foreground text-sm">
              Rename teams, hand leadership to another member, or delete a
              team.
            </p>
          </header>
          {guild.raidTeams.map((t) => (
            <TeamManageCard
              // Name in the key: a rename (here or in another session)
              // remounts the card, so the rename input never holds a stale
              // previous name that an armed button could "rename back" to.
              key={`${t.id}:${t.name}`}
              guildId={guildId}
              team={t}
              memberships={guild.memberships}
            />
          ))}
        </section>
      )}

      {canDeleteGuild && (
        <RemoveGuildSection
          guildId={guildId}
          guildName={guild.name}
          raidTeamCount={guild.raidTeams.length}
        />
      )}
    </>
  );
}

function CreateTeamCard({ guildId }: { guildId: string }) {
  const router = useRouter();
  const utils = api.useUtils();
  const [teamName, setTeamName] = useState("");
  const [teamWclSource, setTeamWclSource] = useState("");
  const createTeam = api.raidTeam.create.useMutation({
    onSuccess: async (team) => {
      setTeamName("");
      setTeamWclSource("");
      await utils.guild.get.invalidate({ guildId });
      // Drop the user straight into the new team's dashboard list so they
      // can add widgets without hunting through the UI.
      router.push(`/guild/${guildId}/team/${team.id}/dashboard` as Route);
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

  return (
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
              Only set this if the team logs under its own WCL guild. You can
              change it any time below.
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
  team: Pick<Team, "id" | "name" | "wclGuildId" | "wclGuildName">;
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
 * One team's management card: inline rename, leadership transfer to any
 * ACTIVE guild member, and Delete via the Danger Zone modal (type the team
 * name to confirm).
 */
function TeamManageCard({
  guildId,
  team,
  memberships,
}: {
  guildId: string;
  team: Team;
  memberships: GuildDetail["memberships"];
}) {
  const utils = api.useUtils();
  const [name, setName] = useState(team.name);
  const [newLeaderId, setNewLeaderId] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  const rename = api.raidTeam.rename.useMutation({
    onSuccess: () => utils.guild.get.invalidate({ guildId }),
  });
  const transfer = api.raidTeam.transferLeadership.useMutation({
    onSuccess: async () => {
      setNewLeaderId("");
      await utils.guild.get.invalidate({ guildId });
    },
  });
  const del = api.raidTeam.delete.useMutation({
    onSuccess: async () => {
      setDeleteOpen(false);
      await utils.guild.get.invalidate({ guildId });
    },
  });

  const activeMembers = memberships.filter((m) => m.status === "ACTIVE");
  const currentLeader = memberships.find(
    (m) => m.user.id === team.leaderUserId,
  );
  const memberLabel = (m: (typeof memberships)[number]) =>
    m.user.displayName ?? m.user.email ?? "Unnamed user";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{team.name}</CardTitle>
        <CardDescription>
          {team._count.memberships} member
          {team._count.memberships === 1 ? "" : "s"} · leader:{" "}
          {currentLeader ? memberLabel(currentLeader) : "no on-site leader"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Rename */}
        <div className="space-y-2">
          <Label htmlFor={`rename-${team.id}`}>Team name</Label>
          <div className="flex gap-2">
            <Input
              id={`rename-${team.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              minLength={2}
              maxLength={60}
              className="flex-1"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                rename.isPending ||
                !name.trim() ||
                name.trim() === team.name
              }
              onClick={() =>
                rename.mutate({ raidTeamId: team.id, name: name.trim() })
              }
            >
              {rename.isPending ? "Renaming…" : "Rename"}
            </Button>
          </div>
          {rename.error && (
            <p className="text-destructive text-xs" role="alert">
              {rename.error.message}
            </p>
          )}
        </div>

        {/* Leadership transfer */}
        <div className="space-y-2">
          <Label htmlFor={`leader-${team.id}`}>Transfer leadership</Label>
          <div className="flex gap-2">
            <select
              id={`leader-${team.id}`}
              className="border-border bg-background flex-1 rounded-md border px-2 py-1.5 text-sm"
              value={newLeaderId}
              onChange={(e) => setNewLeaderId(e.target.value)}
            >
              <option value="">Choose a guild member…</option>
              {activeMembers
                .filter((m) => m.user.id !== team.leaderUserId)
                .map((m) => (
                  <option key={m.user.id} value={m.user.id}>
                    {memberLabel(m)} ({m.role.toLowerCase()})
                  </option>
                ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={transfer.isPending || !newLeaderId}
              onClick={() =>
                transfer.mutate({
                  raidTeamId: team.id,
                  newLeaderUserId: newLeaderId,
                })
              }
            >
              {transfer.isPending ? "Transferring…" : "Transfer"}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            The new leader gets full control of the team (rename, sources,
            deletion, member management).
          </p>
          {transfer.error && (
            <p className="text-destructive text-xs" role="alert">
              {transfer.error.message}
            </p>
          )}
        </div>

        {/* Delete → Danger Zone modal */}
        <div>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => {
              // Reset any stale error from a previous attempt so a freshly
              // opened dialog never shows last time's failure.
              del.reset();
              setDeleteOpen(true);
            }}
          >
            Delete team…
          </Button>
        </div>
        <DangerZoneModal
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          title={`Delete "${team.name}"`}
          description={
            <>
              Permanently removes the raid team, its dashboards, and its{" "}
              {team._count.memberships} member
              {team._count.memberships === 1 ? "" : "s"}. Character snapshots
              and the underlying guild memberships are kept.
            </>
          }
          expectedConfirm={team.name}
          onConfirm={() =>
            del.mutate({ raidTeamId: team.id, confirmName: team.name })
          }
          isPending={del.isPending}
          errorMessage={del.error?.message ?? null}
          confirmLabel={`Delete "${team.name}"`}
          submittingLabel="Deleting…"
        />
      </CardContent>
    </Card>
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
          <span className="font-semibold">every raid team in it</span> (
          {raidTeamCount} team
          {raidTeamCount === 1 ? "" : "s"}), along with their dashboards,
          memberships, and character links. Character data itself is kept.
          Only the guild owner (or a platform admin) can do this.
        </>
      }
      expectedConfirm={guildName}
      onConfirm={() => del.mutate({ guildId, confirmName: guildName })}
      isPending={del.isPending}
      errorMessage={del.error?.message ?? null}
      buttonLabel={`Delete "${guildName}"`}
      submittingLabel="Deleting…"
      helper="This deletes every raid team, dashboard, and membership under the guild. There is no undo."
    />
  );
}
