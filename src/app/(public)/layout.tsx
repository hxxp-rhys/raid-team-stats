import Link from "next/link";

import { siteConfig } from "@/lib/site-config";
import { SiteFooter } from "@/components/site-footer";

/**
 * Layout for the public information page (/security). Mirrors the landing page's
 * width + the auth layout's back-link, and renders the shared (un-removable)
 * site footer. (/about moved under the (app) shell so signed-in users get the
 * full top bar — user menu + My guilds — and no back-link arrow.)
 */
export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-4 py-12 sm:py-16">
      <Link
        href="/"
        className="text-muted-foreground hover:text-foreground mb-10 inline-flex w-fit items-center gap-1.5 text-sm transition-colors"
      >
        <span aria-hidden>←</span> {siteConfig.appName}
      </Link>
      <div className="flex-1">{children}</div>
      <SiteFooter className="mt-16" />
    </main>
  );
}
