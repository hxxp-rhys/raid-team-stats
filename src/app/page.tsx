import Link from "next/link";
import { redirect } from "next/navigation";
import type { Session } from "next-auth";

import { auth } from "@/server/auth";
import { siteConfig } from "@/lib/site-config";
import { SiteFooter } from "@/components/site-footer";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default async function Home() {
  const session =
    (await (auth as unknown as () => Promise<Session | null>)()) ?? null;
  if (session?.user?.id) {
    redirect("/guild");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-16 sm:py-24">
      <section className="flex flex-col items-start gap-6">
        <div className="flex items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={siteConfig.logoUrl}
            alt={`${siteConfig.appName} logo`}
            width={64}
            height={64}
            className="border-border/60 h-16 w-16 rounded-lg border"
          />
          <div className="flex flex-col">
            <span className="text-2xl font-bold tracking-tight">
              {siteConfig.appName}
            </span>
            <span className="text-primary text-sm font-medium tracking-wide">
              {siteConfig.tagline}
            </span>
          </div>
        </div>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          {siteConfig.hero.headline}
        </h1>
        <p className="text-muted-foreground max-w-2xl text-lg">
          {siteConfig.hero.subheading}
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
        {siteConfig.features.map((f) => (
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
          {siteConfig.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <SiteFooter className="mt-auto pt-16" />
    </main>
  );
}
