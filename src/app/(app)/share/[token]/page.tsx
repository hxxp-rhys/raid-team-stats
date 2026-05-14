"use client";

import { Suspense, use } from "react";
import Link from "next/link";

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/trpc-client";
import { parseLayout } from "@/lib/widgets/types";
import { WidgetRender } from "@/components/widgets";

type Params = Promise<{ token: string }>;

/**
 * Public-by-URL dashboard view. Auth.js still gates the page — anonymous
 * visitors are bounced to /signin. After sign-in, the server-side
 * resolver verifies the token's signature AND that the caller is an
 * active guild member. Non-members get a generic "not found" message.
 */
export default function ShareViewPage({ params }: { params: Params }) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-5xl px-4 py-12">
          <p className="text-muted-foreground text-sm">Loading…</p>
        </main>
      }
    >
      <Inner params={params} />
    </Suspense>
  );
}

function Inner({ params }: { params: Params }) {
  const { token } = use(params);
  const q = api.dashboard.getByShareToken.useQuery({ token });

  if (q.isPending) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-12">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
    );
  }
  if (q.error) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>Dashboard not available</CardTitle>
            <CardDescription>{q.error.message}</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  const { dashboard, expiresAt } = q.data;
  const layout = parseLayout(dashboard.layout);
  const expires = new Date(expiresAt);

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-12">
      <header>
        <Link
          href="/guild"
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          ← My guilds
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{dashboard.name}</h1>
        <p className="text-muted-foreground text-sm">
          Shared view · {layout.widgets.length} widget
          {layout.widgets.length === 1 ? "" : "s"} · expires{" "}
          {expires.toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        </p>
      </header>

      {layout.widgets.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>This dashboard is empty</CardTitle>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {layout.widgets.map((w) => (
            <WidgetRender key={w.id} instance={w} raidTeamId={dashboard.raidTeamId} />
          ))}
        </div>
      )}
    </main>
  );
}
