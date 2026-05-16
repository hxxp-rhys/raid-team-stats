import { Suspense } from "react";

import { AppHeader } from "@/components/app-header";

/**
 * Shared chrome for every authenticated route under `(app)`. The header reads
 * the session + DB to render the user menu, so it must sit under Suspense
 * (Next 16 cacheComponents). The page content stays full-width so individual
 * pages keep their own max-width wrappers.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <AppHeader />
      </Suspense>
      {children}
    </>
  );
}
