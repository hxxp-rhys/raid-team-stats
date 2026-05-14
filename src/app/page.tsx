import { env } from "@/env";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center p-8">
      <h1 className="text-3xl font-bold tracking-tight">{env.NEXT_PUBLIC_APP_NAME}</h1>
      <p className="mt-4 text-neutral-400">
        Customizable raid-team stat tracking for World of Warcraft guilds.
      </p>
      <p className="mt-2 text-sm text-neutral-500">
        Phase 1 foundation only. Auth, guilds, and dashboards are not yet wired up.
      </p>
    </main>
  );
}
