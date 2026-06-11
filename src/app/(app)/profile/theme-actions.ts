"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import {
  CUSTOM_THEME,
  isValidTheme,
  parseCustomPalette,
  THEME_COOKIE,
  THEME_CUSTOM_COOKIE,
  type CustomPalette,
  type ThemeId,
} from "@/lib/theme";

const COOKIE_OPTS = {
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  httpOnly: false, // readable from JS so a client-only UI can preview pre-RSC
};

/**
 * Server Action: persist the user's theme choice in a 1-year cookie scoped
 * to "/" so subsequent page loads SSR with the right palette. Revalidates
 * the current path so the change is visible without a manual reload.
 */
export async function setThemeAction(raw: string): Promise<{ ok: boolean }> {
  if (!isValidTheme(raw)) return { ok: false };
  const theme: ThemeId = raw;
  const jar = await cookies();
  jar.set(THEME_COOKIE, theme, COOKIE_OPTS);
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Server Action: persist a user-defined custom palette. The palette is
 * re-validated server-side (every field must be #rrggbb hex) before storage
 * — this is the trust boundary, since the palette is later inlined into the
 * theme <script> at first paint. Sets THEME_COOKIE="custom" + the palette
 * JSON cookie.
 */
export async function setCustomThemeAction(
  palette: CustomPalette,
): Promise<{ ok: boolean }> {
  const parsed = parseCustomPalette(JSON.stringify(palette));
  if (!parsed) return { ok: false };
  const jar = await cookies();
  jar.set(THEME_COOKIE, CUSTOM_THEME, COOKIE_OPTS);
  jar.set(THEME_CUSTOM_COOKIE, JSON.stringify(parsed), COOKIE_OPTS);
  revalidatePath("/", "layout");
  return { ok: true };
}
