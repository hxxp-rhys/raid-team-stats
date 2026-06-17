import Link from "next/link";

import { cn } from "@/lib/utils";
import { siteConfig } from "@/lib/site-config";

/**
 * Public site footer (landing page + info pages). The footer NOTE on the left is
 * self-hoster-customizable (HOMEPAGE_FOOTER_NOTE), but the "About" and
 * "Security" links are a FIXED part of this component — they are not driven by
 * any config/env, so a rebrand cannot remove them. They are the project's
 * attribution + data-transparency surface and are intentionally kept subtle.
 */
export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer className={cn("text-muted-foreground text-xs", className)}>
      <div className="border-border/50 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0">{siteConfig.footerNote}</p>
        <nav className="flex shrink-0 items-center gap-4" aria-label="Site information">
          <Link href="/about" className="hover:text-foreground transition-colors">
            About
          </Link>
          <span aria-hidden className="opacity-40">
            ·
          </span>
          <Link href="/security" className="hover:text-foreground transition-colors">
            Security
          </Link>
        </nav>
      </div>
    </footer>
  );
}
