import Link from "next/link";

import { cn } from "@/lib/utils";
import { siteConfig } from "@/lib/site-config";

/**
 * Site footer, rendered on the public pages AND inside the authenticated app
 * shell. The footer NOTE on the left is self-hoster-customizable
 * (HOMEPAGE_FOOTER_NOTE); the "About"/"Security" links, the AGPL-3.0 license
 * mention, and the "Source" link are a FIXED part of this component — not
 * removable via config/env. The "Source" link is the project's AGPL-3.0
 * section-13 Corresponding-Source offer to network users: its target defaults
 * to the upstream repo, but a MODIFIED self-host points it at its own fork via
 * SOURCE_REPO_URL (see site-config.ts) to meet its own section-13 obligation.
 */
export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer className={cn("text-muted-foreground text-xs", className)}>
      <div className="border-border/50 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0">
          {siteConfig.footerNote} Licensed under{" "}
          <a
            href="https://www.gnu.org/licenses/agpl-3.0.html"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:text-foreground underline-offset-2 transition-colors hover:underline"
          >
            {siteConfig.license}
          </a>
          .
        </p>
        <nav
          className="flex shrink-0 items-center gap-4"
          aria-label="Site information"
        >
          <Link href="/about" className="hover:text-foreground transition-colors">
            About
          </Link>
          <span aria-hidden className="opacity-40">
            ·
          </span>
          <Link
            href="/security"
            className="hover:text-foreground transition-colors"
          >
            Security
          </Link>
          <span aria-hidden className="opacity-40">
            ·
          </span>
          <a
            href={siteConfig.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="hover:text-foreground transition-colors"
          >
            Source
          </a>
        </nav>
      </div>
    </footer>
  );
}
