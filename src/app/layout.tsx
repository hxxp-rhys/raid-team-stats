import { Suspense } from "react";
import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { env } from "@/env";
import { cn } from "@/lib/utils";
import { Providers } from "@/app/providers";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: env.NEXT_PUBLIC_APP_NAME,
  description: "Customizable raid-team stat tracking for World of Warcraft guilds.",
  robots: { index: false, follow: false },
  referrer: "strict-origin-when-cross-origin",
};

// Note: the CSP nonce is set on every response by `src/proxy.ts`. Components
// that need it can read it via `headers()` from "next/headers" — but doing so
// forces dynamic rendering, so wrap such components in <Suspense>.
//
// The <Providers> tree (SessionProvider + QueryClient + tRPC) consumes
// request-time data (cookies, session) and so must sit inside a Suspense
// boundary under Next 16's `cacheComponents` model — otherwise the static
// shell prerender errors out with "Uncached data accessed outside Suspense".

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={cn("dark font-sans", geist.variable)}>
      <body className="bg-background text-foreground min-h-screen antialiased">
        <Suspense fallback={null}>
          <Providers>{children}</Providers>
        </Suspense>
      </body>
    </html>
  );
}
