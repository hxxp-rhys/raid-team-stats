"use client";

import Link from "next/link";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/trpc-client";

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: "text-green-500",
  PENDING: "text-amber-500",
  DEPARTED: "text-muted-foreground",
};

export default function GuildIndexPage() {
  const guilds = api.guild.myGuilds.useQuery();

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your guilds</h1>
          <p className="text-muted-foreground text-sm">
            Guilds discovered from your linked Battle.net characters.
          </p>
        </div>
        <Link href="/profile" className="text-primary text-sm underline-offset-4 hover:underline">
          Back to profile
        </Link>
      </header>

      {guilds.isPending ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : guilds.error ? (
        <p className="text-destructive text-sm" role="alert">
          {guilds.error.message}
        </p>
      ) : guilds.data && guilds.data.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No guilds yet</CardTitle>
            <CardDescription>
              Link Battle.net on your profile, then run <em>Discover guilds</em> to
              populate this list.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/profile"
              className="text-primary text-sm underline-offset-4 hover:underline"
            >
              Go to profile →
            </Link>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {guilds.data?.map((m) => (
            <li key={m.id}>
              <Link
                href={{ pathname: `/guild/${m.guild.id}` }}
                className="hover:border-primary block rounded-lg border border-border bg-card p-4 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-medium">{m.guild.name}</h2>
                    <p className="text-muted-foreground text-xs">
                      {m.guild.region} · {m.guild.realmSlug} · {m.guild.faction}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">{m.role}</p>
                    <p
                      className={`text-xs ${STATUS_BADGE[m.status] ?? "text-muted-foreground"}`}
                    >
                      {m.status}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
