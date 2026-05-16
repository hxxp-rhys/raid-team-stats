"use client";

import Link from "next/link";
import { useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/trpc-client";

type Region = "US" | "EU" | "KR" | "TW";

export default function AdminGuildsPage() {
  const [search, setSearch] = useState("");
  const [region, setRegion] = useState<Region | "">("");

  const guilds = api.admin.listGuilds.useQuery({
    search: search.trim() || undefined,
    region: region || undefined,
  });

  return (
    <section className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Filter</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="g-search">Search</Label>
            <Input
              id="g-search"
              placeholder="guild name or slug"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="g-region">Region</Label>
            <select
              id="g-region"
              value={region}
              onChange={(e) => setRegion(e.target.value as Region | "")}
              className="border-border bg-background h-9 w-full rounded-md border px-2 text-sm"
            >
              <option value="">Any</option>
              {(["US", "EU", "KR", "TW"] as const).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Guilds{" "}
            <span className="text-muted-foreground text-sm">
              ({guilds.data?.length ?? 0})
            </span>
          </CardTitle>
          <CardDescription>
            Newest claim status is the source of truth. UNCLAIMED guilds get
            their first roster-rank-0 user as OWNER via Tier-A discovery.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {guilds.isPending ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : guilds.error ? (
            <p className="text-destructive text-sm" role="alert">
              {guilds.error.message}
            </p>
          ) : guilds.data && guilds.data.length === 0 ? (
            <p className="text-muted-foreground text-sm">No guilds match.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Guild list</caption>
                <thead>
                  <tr className="text-muted-foreground text-left text-xs uppercase">
                    <th scope="col" className="py-1 pr-3 font-medium">Guild</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Region/Realm</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Faction</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Claim</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Members</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Teams</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Claimed by</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {guilds.data?.map((g) => (
                    <tr key={g.id}>
                      <td className="py-2 pr-3">
                        <Link
                          href={{ pathname: `/guild/${g.id}` }}
                          className="text-primary font-medium underline-offset-4 hover:underline"
                        >
                          {g.name}
                        </Link>
                        <p className="text-muted-foreground text-xs">
                          {g.guildSlug}
                        </p>
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        {g.region} / {g.realmSlug}
                      </td>
                      <td className="py-2 pr-3 text-xs">{g.faction}</td>
                      <td className="py-2 pr-3 text-xs">{g.claimStatus}</td>
                      <td className="py-2 pr-3 tabular-nums">
                        {g._count.memberships}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {g._count.raidTeams}
                      </td>
                      <td className="text-muted-foreground py-2 pr-3 text-xs">
                        {g.claimedBy
                          ? g.claimedBy.displayName ?? g.claimedBy.email
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
