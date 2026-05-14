import Link from "next/link";
import { redirect } from "next/navigation";
import type { Session } from "next-auth";

import { env } from "@/env";
import { auth } from "@/server/auth";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const features: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Live multi-source sync",
    body:
      "Tracked raid-team members refresh hourly across Blizzard, Warcraft Logs, and Raider.IO. Full guild rosters refresh weekly after reset.",
  },
  {
    title: "Customizable dashboards",
    body:
      "Drag-drop widget builder: iLvL ladders, vault progress, gear audit, tier-set tracker, M+ ratings, and WCL parses — share read-only links with your team.",
  },
  {
    title: "Battle.net verified access",
    body:
      "Guild membership is auto-verified from your linked Battle.net characters. No spreadsheets, no manual roster maintenance.",
  },
  {
    title: "Security-first",
    body:
      "AES-256-GCM column encryption for OAuth tokens, optional TOTP MFA, full audit log, and a strict CSP. Self-hostable on a single VPS.",
  },
];

export default async function Home() {
  const session =
    (await (auth as unknown as () => Promise<Session | null>)()) ?? null;
  if (session?.user?.id) {
    redirect("/guild");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-16 sm:py-24">
      <section className="flex flex-col items-start gap-6">
        <p className="text-primary text-xs font-medium uppercase tracking-widest">
          {env.NEXT_PUBLIC_APP_NAME}
        </p>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Stop hand-auditing your raid team in a spreadsheet.
        </h1>
        <p className="text-muted-foreground max-w-2xl text-lg">
          Customizable, automatically synced dashboards for your World of
          Warcraft raid team. Pulls live data from Battle.net, Warcraft Logs,
          and Raider.IO. Built for guild officers who want answers, not
          maintenance work.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/signup" className={buttonVariants({ size: "lg" })}>
            Create an account
          </Link>
          <Link
            href="/signin"
            className={buttonVariants({ size: "lg", variant: "outline" })}
          >
            Sign in
          </Link>
        </div>
      </section>

      <section className="mt-16 grid gap-4 sm:grid-cols-2">
        {features.map((f) => (
          <Card key={f.title}>
            <CardHeader>
              <CardTitle className="text-lg">{f.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription className="text-sm">{f.body}</CardDescription>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="mt-16">
        <h2 className="text-xl font-semibold tracking-tight">How it works</h2>
        <ol className="text-muted-foreground mt-4 list-decimal space-y-2 pl-5 text-sm">
          <li>Register with an email + password, verify, and sign in.</li>
          <li>
            Link your Battle.net account on your profile — the app discovers
            every guild your characters belong to.
          </li>
          <li>
            The guild master can claim the guild (auto-claim if you&apos;re
            rank 0); officers create raid teams and pick the tracked roster.
          </li>
          <li>
            Compose dashboards from a widget palette and share read-only links
            with the team.
          </li>
        </ol>
      </section>

      <footer className="text-muted-foreground mt-auto pt-16 text-xs">
        <p>
          {env.NEXT_PUBLIC_APP_NAME} is self-hosted, open-source, and
          guild-private by default.
        </p>
      </footer>
    </main>
  );
}
