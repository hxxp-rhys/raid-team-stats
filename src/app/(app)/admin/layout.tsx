import { redirect } from "next/navigation";
import type { Session } from "next-auth";

import { auth } from "@/server/auth";
import { isPlatformAdmin } from "@/server/api/trpc";
import { AdminNav } from "./admin-nav";

/**
 * Gate every /admin/* page on platform-admin status. Non-admins get a 404 via
 * notFound() so we don't reveal that the surface exists.
 *
 * The tRPC procedures under `admin.*` also gate on admin — defense in depth —
 * but checking at the layout means non-admins never trigger client-side
 * queries that would 404 anyway.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session =
    (await (auth as unknown as () => Promise<Session | null>)()) ?? null;
  if (!session?.user?.id) {
    redirect("/signin?callbackUrl=/admin");
  }
  if (!(await isPlatformAdmin(session.user.id))) {
    // Match the tRPC behavior: 404 rather than 403 to keep the admin surface
    // private.
    const { notFound } = await import("next/navigation");
    notFound();
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <header className="mb-2">
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-muted-foreground text-sm">
          Platform-wide management. Visible only to admins.
        </p>
      </header>
      <AdminNav />
      {children}
    </main>
  );
}
