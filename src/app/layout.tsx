import type { Metadata } from "next";
import { env } from "@/env";
import "./globals.css";

export const metadata: Metadata = {
  title: env.NEXT_PUBLIC_APP_NAME,
  description: "Customizable raid-team stat tracking for World of Warcraft guilds.",
  robots: { index: false, follow: false },
  referrer: "strict-origin-when-cross-origin",
};

// Note: the CSP nonce is set on every response by `src/proxy.ts`. Components
// that need it can read it via `headers()` from "next/headers" — but doing so
// forces dynamic rendering, so wrap such components in <Suspense>.

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        {children}
      </body>
    </html>
  );
}
