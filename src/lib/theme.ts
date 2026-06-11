/**
 * Theme catalogue. The dark "default" theme is what the app shipped with;
 * the other four are WoW-flavored variants users can opt into via the
 * profile-page selector.
 *
 * Server-rendered: layout.tsx reads the `rts-theme` cookie and applies it
 * as `data-theme="…"` on the <html> element so the very first paint has
 * the right palette (no flash). The setting persists across sessions via
 * a 1-year cookie scoped to /.
 */

export const THEME_IDS = [
  "default-dark",
  "forge",
  "anvil",
  "alliance",
  "horde",
  "parchment",
  "void",
  "mocha",
  "nord",
  "rose",
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeId = "default-dark";

export const THEME_META: Record<ThemeId, { name: string; description: string }> = {
  "default-dark": {
    name: "Default dark",
    description: "Neutral high-contrast dark.",
  },
  forge: {
    name: "Forge",
    description: "Stat Smith dark: deep navy, forge-orange, rune teal.",
  },
  anvil: {
    name: "Anvil",
    description: "Stat Smith light: warm parchment + steel, forge-orange.",
  },
  alliance: {
    name: "Alliance",
    description: "Royal blue + gold. Cool, high-contrast.",
  },
  horde: {
    name: "Horde",
    description: "Crimson + iron. Warm and aggressive.",
  },
  parchment: {
    name: "Parchment",
    description: "Light sepia / spreadsheet feel.",
  },
  void: {
    name: "Void",
    description: "Deep purple + neon teal.",
  },
  mocha: {
    name: "Mocha",
    description: "Catppuccin Mocha — deep indigo + lavender-mauve.",
  },
  nord: {
    name: "Nord",
    description: "Arctic polar-night blue-gray + frost cyan.",
  },
  rose: {
    name: "Rosé",
    description: "Rosé Pine — muted plum + iris and rose accents.",
  },
};

export const THEME_COOKIE = "rts-theme";

export const isValidTheme = (v: unknown): v is ThemeId =>
  typeof v === "string" && (THEME_IDS as readonly string[]).includes(v);

/**
 * Whether the theme's base palette is light (so we should NOT also apply
 * the `.dark` class). All others are dark-based.
 */
export const isLightTheme = (t: ThemeId): boolean =>
  t === "parchment" || t === "anvil";
