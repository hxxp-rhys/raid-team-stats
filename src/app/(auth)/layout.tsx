import type { ReactNode } from "react";
import Link from "next/link";
import { siteConfig } from "@/lib/site-config";

export default function AuthLayout({ children }: { children: ReactNode }) {
  // Top-anchored (NOT vertically centred) so the card position stays stable
  // when its content height changes — e.g. the signin form switching between
  // the email/password step (2 fields) and the MFA step (1 field) used to
  // re-centre the card and visibly shift the layout. `100dvh` honours the
  // dynamic mobile viewport, and `overflow-y-auto` lets the page scroll if
  // the card grows taller than the viewport instead of clipping.
  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col overflow-y-auto px-4 py-8 sm:py-16">
      <Link
        href="/"
        className="text-muted-foreground hover:text-foreground mb-6 self-center text-sm transition-colors"
      >
        ← {siteConfig.appName}
      </Link>
      {children}
    </main>
  );
}
