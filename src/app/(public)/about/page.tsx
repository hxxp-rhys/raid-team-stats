import type { Metadata } from "next";

import { siteConfig, UPSTREAM } from "@/lib/site-config";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "About",
  description: `About ${UPSTREAM.projectName} — the open-source raid-team analytics project this site is built on.`,
};

export default function AboutPage() {
  return (
    <article className="space-y-10">
      <header className="flex items-center gap-4">
        {/* The ORIGINAL project mark — credit is shown with the upstream brand,
            independent of any rebrand of this instance. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={UPSTREAM.logoUrl}
          alt={`${UPSTREAM.projectName} logo`}
          width={56}
          height={56}
          className="border-border/60 h-14 w-14 rounded-lg border"
        />
        <div className="flex flex-col">
          <span className="text-xl font-bold tracking-tight">
            {UPSTREAM.projectName}
          </span>
          <span className="text-primary text-sm font-medium tracking-wide">
            {UPSTREAM.tagline}
          </span>
        </div>
      </header>

      <section className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight">About this project</h1>
        <p className="text-muted-foreground leading-relaxed">
          {siteConfig.appName === UPSTREAM.projectName ? (
            <>{UPSTREAM.projectName} is a</>
          ) : (
            <>
              <span className="text-foreground font-medium">
                {siteConfig.appName}
              </span>{" "}
              is a self-hosted instance of{" "}
              <span className="text-foreground font-medium">
                {UPSTREAM.projectName}
              </span>
              , a
            </>
          )}{" "}
          free, open-source platform for World of Warcraft raid teams:
          customizable, automatically-synced dashboards that pull live data from
          Battle.net, Warcraft Logs, and Raider.IO so officers spend their time
          leading raids instead of maintaining spreadsheets.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Credits &amp; source</h2>
        <p className="text-muted-foreground leading-relaxed">
          {UPSTREAM.projectName} is created and maintained by{" "}
          <a
            href={UPSTREAM.authorUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline underline-offset-4 hover:no-underline"
          >
            hxxp-rhys
          </a>
          . The complete source code is available on{" "}
          <a
            href={UPSTREAM.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline underline-offset-4 hover:no-underline"
          >
            GitHub
          </a>{" "}
          as free, open-source software — you are welcome to read, self-host, and
          modify it.
        </p>
      </section>

      <section className="border-border bg-muted/30 space-y-4 rounded-lg border p-5">
        <h2 className="text-lg font-semibold tracking-tight">
          Support development
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          {UPSTREAM.projectName} is free and open-source, and always will be. If
          it is useful to you, you can <em>optionally</em> support its continued
          development through GitHub Sponsors. Sponsorship is a{" "}
          <span className="text-foreground font-medium">
            voluntary donation
          </span>{" "}
          to the project&apos;s developer to help fund ongoing work — it is{" "}
          <span className="text-foreground font-medium">not a purchase</span>,
          unlocks no features, and grants no goods, services, license, warranty,
          or any commercial or contractual relationship. Nothing on this site is
          gated behind it.
        </p>
        <a
          href={UPSTREAM.sponsorUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          ♥ Sponsor on GitHub
        </a>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight">Disclaimer</h2>
        <p className="text-muted-foreground text-xs leading-relaxed">
          This is unofficial, fan-made software for World of Warcraft. It is not
          affiliated with, endorsed, sponsored, or approved by Blizzard
          Entertainment, Inc. World of Warcraft and all associated names,
          marks, and imagery are trademarks of Blizzard Entertainment, Inc. All
          such trademarks remain the property of their respective owners and are
          used here only to describe compatibility.
        </p>
      </section>
    </article>
  );
}
