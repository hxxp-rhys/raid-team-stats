import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { Session } from "next-auth";

import { auth } from "@/server/auth";
import { ThemeSelector } from "@/app/(app)/profile/theme-selector";
import {
  CUSTOM_THEME,
  DEFAULT_CUSTOM_PALETTE,
  DEFAULT_THEME,
  isValidTheme,
  parseCustomPalette,
  THEME_COOKIE,
  THEME_CUSTOM_COOKIE,
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
  // `current` can be a built-in ThemeId or the literal "custom".
  const current: ThemeId | typeof CUSTOM_THEME =
    themeRaw === CUSTOM_THEME
      ? CUSTOM_THEME
      : isValidTheme(themeRaw)
        ? themeRaw
        : DEFAULT_THEME;
  const customPalette =
    parseCustomPalette(jar.get(THEME_CUSTOM_COOKIE)?.value) ??
    DEFAULT_CUSTOM_PALETTE;

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
        <ThemeSelector current={current} customPalette={customPalette} />
      </div>
    </main>
  );
}
