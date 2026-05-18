import Link from "next/link";
import type { Session } from "next-auth";

import { auth } from "@/server/auth";
import { db } from "@/lib/db";
import { env } from "@/env";
import { UserMenu } from "./user-menu";

/**
 * Top bar shown on every authenticated app page. Server-rendered so the
 * admin-only "Admin" entry never ships down for non-admins. The dropdown
 * itself is a client component (state + click-outside).
 *
 * Admin status here mirrors `isPlatformAdmin` (env id, env email, or DB
 * column). Kept inline to avoid a route-handler-only import.
 */
export async function AppHeader() {
  const session =
    (await (auth as unknown as () => Promise<Session | null>)()) ?? null;
  if (!session?.user?.id) return null;

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, displayName: true, isAdmin: true },
  });
  if (!user) return null;

  const isAdmin =
    user.isAdmin ||
    env.ADMIN_USER_IDS.includes(user.id) ||
    env.ADMIN_EMAILS.includes(user.email.toLowerCase());

  const label = user.displayName ?? user.email;

  return (
    <header className="border-border bg-background/95 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
        <Link
          href="/"
          className="group flex min-w-0 items-center gap-2.5"
          title={`${env.NEXT_PUBLIC_APP_NAME} — forging numbers into insight`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/stat-smith-logo.png"
            alt={`${env.NEXT_PUBLIC_APP_NAME} logo`}
            width={28}
            height={28}
            className="border-border/60 h-7 w-7 shrink-0 rounded"
          />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="text-foreground group-hover:text-primary truncate text-sm font-semibold tracking-tight">
              {env.NEXT_PUBLIC_APP_NAME}
            </span>
            <span className="text-muted-foreground hidden truncate text-[10px] sm:block">
              forging numbers into insight
            </span>
          </span>
        </Link>
        <UserMenu label={label} isAdmin={isAdmin} />
      </div>
    </header>
  );
}
