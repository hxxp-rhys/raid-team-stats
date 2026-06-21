import { Suspense } from "react";

import { AppHeader } from "@/components/app-header";
import { SiteFooter } from "@/components/site-footer";

/**
 * Shared chrome for every authenticated route under `(app)`. The header reads
 * the session + DB to render the user menu, so it must sit under Suspense
 * (Next 16 cacheComponents). The page content stays full-width so individual
 * pages keep their own max-width wrappers. The footer carries the AGPL-3.0
 * license + Corresponding-Source link — the AGPL section-13 offer to logged-in
 * (network-interacting) users; it reads only static site-config, so no Suspense.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <AppHeader />
      </Suspense>
      {children}
      <div className="mx-auto w-full max-w-[1400px] px-4 pt-6 pb-8">
        <SiteFooter />
      </div>
    </>
  );
}
