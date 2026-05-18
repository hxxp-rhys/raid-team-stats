import { Suspense } from "react";
import { cookies, headers } from "next/headers";
import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { env } from "@/env";
import { cn } from "@/lib/utils";
import { Providers } from "@/app/providers";
import { CSP_NONCE_HEADER } from "@/server/security/csp";
import {
  DEFAULT_THEME,
  isLightTheme,
  isValidTheme,
  THEME_COOKIE,
  type ThemeId,
} from "@/lib/theme";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: {
    default: `${env.NEXT_PUBLIC_APP_NAME} — forging numbers into insight`,
    template: `%s — ${env.NEXT_PUBLIC_APP_NAME}`,
  },
  description:
    "Stat Smith — forging numbers into insight. Customizable, auto-synced raid-team stat dashboards for World of Warcraft guilds.",
  robots: { index: false, follow: false },
  referrer: "strict-origin-when-cross-origin",
};

// Next 16 `cacheComponents`: the <html>/<body> shell must be a *static*
// prerendered shell — it cannot read request-time data (cookies/headers)
// at the top level or the whole route is blocked from prerendering
// ("Runtime data was accessed outside of <Suspense>").
//
// So the shell renders with the DEFAULT theme, and <ThemeScript> — a
// Suspense-wrapped child — reads the theme cookie and emits a nonced
// inline script that applies the real theme to <html> before the body
// paints. Default-dark users (the default) see no flash; the four opt-in
// themes may flash for a frame on the very first paint, which is the
// accepted trade-off under the static-shell model.
//
// <Providers> (SessionProvider + tRPC + QueryClient) consumes request
// data too, so it sits in its own Suspense boundary for the same reason.

/**
 * Reads the persisted theme cookie and the per-request CSP nonce, then
 * emits an inline script that applies the theme to <html> synchronously
 * before the rest of the body is parsed. Must be rendered inside
 * <Suspense> — it accesses request-time data by design.
 */
async function ThemeScript() {
  const [jar, hdrs] = await Promise.all([cookies(), headers()]);
  const raw = jar.get(THEME_COOKIE)?.value;
  const theme: ThemeId = isValidTheme(raw) ? raw : DEFAULT_THEME;
  const light = isLightTheme(theme);
  // The proxy sets a fresh nonce on every request; the strict CSP has no
  // 'unsafe-inline', so this script is rejected without it.
  const nonce = hdrs.get(CSP_NONCE_HEADER) ?? undefined;

  // `theme` is already validated server-side, so JSON.stringify of a known
  // ThemeId is safe to inline. Toggling only the `.dark` class preserves
  // the font-sans / geist variable classes on <html>.
  const js =
    `try{var d=document.documentElement;` +
    `d.setAttribute("data-theme",${JSON.stringify(theme)});` +
    `d.classList.${light ? "remove" : "add"}("dark");}catch(e){}`;

  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: js }} />;
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Static shell: default theme. <ThemeScript> corrects it before paint.
  return (
    <html
      lang="en"
      data-theme={DEFAULT_THEME}
      className={cn("dark font-sans", geist.variable)}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground min-h-screen antialiased">
        <Suspense fallback={null}>
          <ThemeScript />
        </Suspense>
        <Suspense fallback={null}>
          <Providers>{children}</Providers>
        </Suspense>
      </body>
    </html>
  );
}
