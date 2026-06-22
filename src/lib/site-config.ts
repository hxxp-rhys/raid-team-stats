import { env } from "@/env";

/**
 * Central, server-side branding + homepage configuration.
 *
 * Self-hosters customize the site by setting the optional `APP_*` / `BRAND_*` /
 * `HOMEPAGE_*` SERVER env vars (see .env.example). These are read at RUNTIME on
 * the server, so they work with the pre-built Docker image with NO rebuild —
 * unlike `NEXT_PUBLIC_*`, which Next inlines at build time. Every consumer
 * (homepage, header, <metadata>, footer, info pages, emails, MFA issuer) is a
 * server component / server module, so reading server env here is safe.
 *
 * This module is SERVER-ONLY: `siteConfig.appName` reads the server-only
 * `APP_NAME`, which `@t3-oss/env` will refuse to expose to the client. Do not
 * import it from a "use client" component.
 */

/**
 * Upstream project identity. FIXED attribution that intentionally survives
 * rebranding — it powers the un-removable footer links and the /about credit +
 * GitHub Sponsors link. This is the project's open-source attribution; keep it
 * as constants (NOT env-configurable) so a rebrand can restyle the site without
 * stripping credit to the original work.
 */
export const UPSTREAM = {
  projectName: "Raid Team Stats",
  tagline: "forging numbers into insight",
  /** The source repository. */
  repoUrl: "https://github.com/hxxp-rhys/raid-team-stats",
  /** The original author's GitHub profile. */
  authorUrl: "https://github.com/hxxp-rhys",
  /** GitHub Sponsors page (voluntary donations to fund development). */
  sponsorUrl: "https://github.com/sponsors/hxxp-rhys",
  /** Original project logo (bundled), used on the credit page regardless of rebrand. */
  logoUrl: "/stat-smith-logo.png",
} as const;

type HomepageFeature = { title: string; body: string };

const DEFAULT_FEATURES: ReadonlyArray<HomepageFeature> = [
  {
    title: "Live multi-source sync",
    body: "Tracked raid-team members refresh hourly, pulling live data from Blizzard, Warcraft Logs, and Raider.IO. Full guild rosters re-sync weekly from Battle.net after reset.",
  },
  {
    title: "Customizable dashboards",
    body: "Drag-drop widget builder: iLvL ladders, vault progress, gear audit, tier-set tracker, M+ ratings, and WCL parses — share read-only links with your team.",
  },
  {
    title: "Battle.net verified access",
    body: "Guild membership is auto-verified from your linked Battle.net characters. No spreadsheets, no manual roster maintenance.",
  },
  {
    title: "Security-first",
    body: "AES-256-GCM encryption at rest for all PII and OAuth tokens, optional TOTP MFA, full audit log, and a strict CSP. Self-hostable on a single server.",
  },
];

const DEFAULT_STEPS: ReadonlyArray<string> = [
  "Register with an email + password, verify, and sign in.",
  "Link your Battle.net account on the Account page — the app discovers every guild your characters belong to.",
  "The guild master claims the guild (auto-claim at rank 0); officers create raid teams and pick the tracked roster.",
  "Compose dashboards from a widget palette and share read-only links with the team.",
];

// `appName` resolves through the runtime server var first, then the build-time
// public var (which has its own "Raid Team Stats" default), so it is always defined.
const appName = env.APP_NAME ?? env.NEXT_PUBLIC_APP_NAME;

export type SiteConfig = {
  appName: string;
  tagline: string;
  description: string;
  logoUrl: string;
  hero: { headline: string; subheading: string };
  footerNote: string;
  /** AGPL-3.0 section-13 Corresponding-Source URL for THIS instance. */
  sourceUrl: string;
  /** SPDX license identifier, shown in the footer. */
  license: string;
  features: ReadonlyArray<HomepageFeature>;
  steps: ReadonlyArray<string>;
};

export const siteConfig: SiteConfig = {
  appName,
  tagline: env.APP_TAGLINE ?? UPSTREAM.tagline,
  description:
    env.APP_DESCRIPTION ??
    "Customizable, auto-synced raid-team stat dashboards for World of Warcraft guilds.",
  logoUrl: env.BRAND_LOGO_URL ?? UPSTREAM.logoUrl,
  hero: {
    headline:
      env.HOMEPAGE_HEADLINE ?? "Stop hand-auditing your raid team in a spreadsheet.",
    subheading:
      env.HOMEPAGE_SUBHEADING ??
      "Customizable, automatically synced dashboards for your World of Warcraft raid team. Pulls live data from Battle.net, Warcraft Logs, and Raider.IO. Built for guild officers who want answers, not maintenance work.",
  },
  footerNote:
    env.HOMEPAGE_FOOTER_NOTE ??
    `${appName} is self-hosted, open-source, and guild-private by default.`,
  // AGPL-3.0 section-13: the Corresponding-Source offer shown to network users.
  // Defaults to the upstream repo; a modified self-host overrides it via
  // SOURCE_REPO_URL to point at its own fork.
  sourceUrl: env.SOURCE_REPO_URL ?? UPSTREAM.repoUrl,
  license: "AGPL-3.0-or-later",
  features: DEFAULT_FEATURES,
  steps: DEFAULT_STEPS,
};
