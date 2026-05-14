"use client";

import { use } from "react";
import Link from "next/link";

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
      <header>
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
      </header>

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
