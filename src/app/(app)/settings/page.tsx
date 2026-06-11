import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { Session } from "next-auth";

import { auth } from "@/server/auth";
import { ThemeSelector } from "@/app/(app)/profile/theme-selector";
import {
  DEFAULT_THEME,
  isValidTheme,
  THEME_COOKIE,
  type ThemeId,
} from "@/lib/theme";

export default async function SettingsPage() {
  const session =
    (await (auth as unknown as () => Promise<Session | null>)()) ?? null;
  if (!session?.user?.id) {
    redirect("/signin?callbackUrl=/settings");
  }

  const jar = await cookies();
  const themeRaw = jar.get(THEME_COOKIE)?.value;
  const theme: ThemeId = isValidTheme(themeRaw) ? themeRaw : DEFAULT_THEME;

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Themes</h1>
        <p className="text-muted-foreground text-sm">
          Choose a palette or build your own. Account and security live under{" "}
          <span className="text-foreground">Account</span> in the menu.
        </p>
      </header>

      <div className="space-y-6">
        <ThemeSelector current={theme} />
      </div>
    </main>
  );
}
