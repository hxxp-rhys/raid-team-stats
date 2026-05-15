"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { isValidTheme, THEME_COOKIE, type ThemeId } from "@/lib/theme";

/**
 * Server Action: persist the user's theme choice in a 1-year cookie scoped
 * to "/" so subsequent page loads SSR with the right palette. Revalidates
 * the current path so the change is visible without a manual reload.
 */
export async function setThemeAction(raw: string): Promise<{ ok: boolean }> {
  if (!isValidTheme(raw)) return { ok: false };
  const theme: ThemeId = raw;
  const jar = await cookies();
  jar.set(THEME_COOKIE, theme, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: false, // readable from JS so a client-only UI can preview pre-RSC
  });
  revalidatePath("/", "layout");
  return { ok: true };
}
