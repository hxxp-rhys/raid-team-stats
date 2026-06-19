"use client";

import { Suspense, use, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";

import { Button, buttonVariants } from "@/components/ui/button";
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
import { api } from "@/lib/trpc-client";

type Params = Promise<{ guildId: string; teamId: string }>;

export default function DashboardListPage({ params }: { params: Params }) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-3xl px-4 py-12">
          <p className="text-muted-foreground text-sm">Loading…</p>
        </main>
      }
    >
      <Inner params={params} />
    </Suspense>
  );
}

function Inner({ params }: { params: Params }) {
  const { guildId, teamId } = use(params);
  const router = useRouter();
  const utils = api.useUtils();

  const list = api.dashboard.list.useQuery({ raidTeamId: teamId });

  const [name, setName] = useState("");
  const create = api.dashboard.create.useMutation({
    onSuccess: async (dashboard) => {
      setName("");
      await utils.dashboard.list.invalidate({ raidTeamId: teamId });
      router.push(
        `/guild/${guildId}/team/${teamId}/dashboard/${dashboard.id}/edit` as Route,
      );
    },
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate({ raidTeamId: teamId, name: name.trim() });
  };

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-12">
      <header>
        <Link
          href={`/guild/${guildId}/team/${teamId}` as Route}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          ← Team
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Dashboards</h1>
        <p className="text-muted-foreground text-sm">
          Saved layouts for this raid team. Each dashboard renders widgets over
          the team&apos;s latest snapshot data.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Existing dashboards</CardTitle>
          <CardDescription>
            {list.isPending
              ? "Loading…"
              : list.data && list.data.length === 0
                ? "No dashboards yet."
                : `${list.data?.length} dashboard${list.data?.length === 1 ? "" : "s"}.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {list.isPending ? null : list.error ? (
            <p className="text-destructive text-sm" role="alert">
              {list.error.message}
            </p>
          ) : list.data && list.data.length > 0 ? (
            <ul className="divide-border divide-y">
              {list.data.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between gap-3 py-3 text-sm"
                >
                  <div>
                    <p className="font-medium">{d.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {d.visibility} · /{d.slug}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Link
                      href={
                        `/guild/${guildId}/team/${teamId}/dashboard/${d.id}` as Route
                      }
                      className={buttonVariants({ size: "sm", variant: "outline" })}
                    >
                      View
                    </Link>
                    <Link
                      href={
                        `/guild/${guildId}/team/${teamId}/dashboard/${d.id}/edit` as Route
                      }
                      className={buttonVariants({ size: "sm", variant: "outline" })}
                    >
                      Edit
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create a dashboard</CardTitle>
          <CardDescription>
            Pick a name. You&apos;ll be taken straight to the edit page to add
            widgets.
          </CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit} noValidate>
          <CardContent className="space-y-3 pb-5">
            <div className="space-y-2">
              <Label htmlFor="dashboard-name">Dashboard name</Label>
              <Input
                id="dashboard-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Weekly audit"
                minLength={2}
                maxLength={80}
                required
              />
            </div>
            {create.error && (
              <p className="text-destructive text-sm" role="alert">
                {create.error.message}
              </p>
            )}
          </CardContent>
          <CardFooter>
            <Button
              type="submit"
              size="sm"
              disabled={create.isPending || !name.trim()}
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </main>
  );
}
