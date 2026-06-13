"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, loggerLink } from "@trpc/client";
import { SessionProvider } from "next-auth/react";
import superjson from "superjson";

import { api } from "@/lib/trpc-client";
import { getShareTokenHeader } from "@/lib/share-token-header";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  const [trpcClient] = useState(() =>
    api.createClient({
      links: [
        loggerLink({
          enabled: (op) =>
            process.env.NODE_ENV === "development" &&
            op.direction === "down" &&
            op.result instanceof Error,
        }),
        httpBatchLink({
          url: "/api/trpc",
          transformer: superjson,
          headers() {
            // Public-share viewing: the /share page parks its token here so
            // widget data queries can authorize anonymously (read-only,
            // token's team only). Absent everywhere else.
            const shareToken = getShareTokenHeader();
            return shareToken ? { "x-share-token": shareToken } : {};
          },
        }),
      ],
    }),
  );

  return (
    <SessionProvider>
      <api.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </api.Provider>
    </SessionProvider>
  );
}
