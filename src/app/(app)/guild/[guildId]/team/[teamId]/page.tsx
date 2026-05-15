"use client";

import { use, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/trpc-client";

type Params = Promise<{ guildId: string; teamId: string }>;

const formatRelative = (date: Date | string | null | undefined): string => {
  if (!date) return "never";
  const d = typeof date === "string" ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

export default function TeamDetailPage({ params }: { params: Params }) {
  const { guildId, teamId } = use(params);

  const team = api.raidTeam.get.useQuery({ raidTeamId: teamId });
  const stats = api.snapshot.latestForTeam.useQuery({ raidTeamId: teamId });

  if (team.isPending) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
    );
  }
  if (team.error) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>Team not found</CardTitle>
            <CardDescription>{team.error.message}</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }
  const t = team.data!;

  return (
    <main className="mx-auto max-w-4xl space-y-8 px-4 py-12">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <Link
            href={{ pathname: `/guild/${guildId}` }}
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            ← {t.guild.name}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t.name}</h1>
          <p className="text-muted-foreground text-sm">
            {t.memberships.length} active member
            {t.memberships.length === 1 ? "" : "s"} · visibility{" "}
            {t.visibility.toLowerCase()}
          </p>
        </div>
        <Link
          href={{ pathname: `/guild/${guildId}/team/${teamId}/dashboard` }}
          className="text-primary text-sm underline-offset-4 hover:underline"
        >
          Dashboards →
        </Link>
      </header>

      <ManageMembers teamId={teamId} />

      <Card>
        <CardHeader>
          <CardTitle>Roster</CardTitle>
          <CardDescription>
            Latest item level, level, and Mythic+ rating from each character&apos;s
            most recent Tier A sync.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {stats.isPending ? (
            <p className="text-muted-foreground text-sm">Loading snapshots…</p>
          ) : stats.error ? (
            <p className="text-destructive text-sm" role="alert">
              {stats.error.message}
            </p>
          ) : stats.data && stats.data.members.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No members yet. Add characters from the team roster to start
              tracking.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="py-2 pr-4 font-medium">Character</th>
                    <th className="py-2 pr-4 font-medium">Realm</th>
                    <th className="py-2 pr-4 font-medium text-right">iLvL</th>
                    <th className="py-2 pr-4 font-medium text-right">Level</th>
                    <th className="py-2 pr-4 font-medium text-right">M+</th>
                    <th className="py-2 pr-4 font-medium">Gear audit</th>
                    <th className="py-2 font-medium">Last sync</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {stats.data?.members.map(({ character, latest }) => {
                    const missing =
                      (latest.equipment?.missingEnchantsCount ?? 0) +
                      (latest.equipment?.missingGemsCount ?? 0);
                    return (
                      <tr key={character.id}>
                        <td className="py-2 pr-4 font-medium">{character.name}</td>
                        <td className="py-2 pr-4 text-muted-foreground">
                          {character.realmSlug}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {latest.equipment?.itemLevel ??
                            latest.character?.itemLevel ??
                            "—"}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {latest.character?.level ?? character.level ?? "—"}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {latest.mplus?.currentRating?.toString() ?? "—"}
                        </td>
                        <td className="py-2 pr-4">
                          {missing === 0 ? (
                            <span className="text-green-500">✓ clean</span>
                          ) : (
                            <span className="text-amber-500">
                              {missing} issue{missing === 1 ? "" : "s"}
                            </span>
                          )}
                        </td>
                        <td className="py-2 text-muted-foreground">
                          {formatRelative(character.lastSyncedAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function ManageMembers({ teamId }: { teamId: string }) {
  const utils = api.useUtils();
  const team = api.raidTeam.get.useQuery({ raidTeamId: teamId });
  const eligible = api.raidTeam.eligibleCharacters.useQuery({ raidTeamId: teamId });
  const [pick, setPick] = useState<string>("");
  const [pickRole, setPickRole] = useState<"MEMBER" | "CO_LEADER">("MEMBER");

  const invalidate = async () => {
    await Promise.all([
      utils.raidTeam.get.invalidate({ raidTeamId: teamId }),
      utils.raidTeam.eligibleCharacters.invalidate({ raidTeamId: teamId }),
    ]);
  };

  const add = api.raidTeam.addMember.useMutation({
    onSuccess: async () => {
      setPick("");
      setPickRole("MEMBER");
      await invalidate();
    },
  });
  const remove = api.raidTeam.removeMember.useMutation({
    onSuccess: invalidate,
  });

  // Permission check is server-side; if the user can't add, eligibleCharacters
  // returns FORBIDDEN and we hide the add form. Members can still see roster.
  const canManage = !eligible.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>
          {canManage
            ? "Add or remove characters tracked by this raid team. Characters must already be active members of the guild."
            : "Active roster. Co-leaders and above can add or remove members."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {team.data && team.data.memberships.length === 0 ? (
          <p className="text-muted-foreground text-sm">No members yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {team.data?.memberships.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between py-2 text-sm"
              >
                <div>
                  <span className="font-medium">{m.character.name}</span>
                  <span className="text-muted-foreground ml-2">
                    {m.character.realmSlug} · lvl {m.character.level ?? "—"} ·{" "}
                    {m.role.toLowerCase()}
                  </span>
                </div>
                {canManage && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() =>
                      remove.mutate({
                        raidTeamId: teamId,
                        characterId: m.character.id,
                      })
                    }
                    disabled={remove.isPending}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          <form
            className="flex flex-wrap items-center gap-2 border-t border-border pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!pick) return;
              add.mutate({ raidTeamId: teamId, characterId: pick, role: pickRole });
            }}
          >
            <select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className="bg-background border-border h-8 rounded-md border px-2 text-sm"
              disabled={eligible.isPending || (eligible.data?.length ?? 0) === 0}
            >
              <option value="">
                {eligible.isPending
                  ? "Loading…"
                  : (eligible.data?.length ?? 0) === 0
                    ? "No eligible characters"
                    : "Select a character"}
              </option>
              {eligible.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.realmSlug})
                </option>
              ))}
            </select>
            <select
              value={pickRole}
              onChange={(e) => setPickRole(e.target.value as "MEMBER" | "CO_LEADER")}
              className="bg-background border-border h-8 rounded-md border px-2 text-sm"
            >
              <option value="MEMBER">Member</option>
              <option value="CO_LEADER">Co-leader</option>
            </select>
            <Button type="submit" disabled={!pick || add.isPending} size="sm">
              {add.isPending ? "Adding…" : "Add to team"}
            </Button>
            {add.error && (
              <p className="text-destructive text-sm" role="alert">
                {add.error.message}
              </p>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
