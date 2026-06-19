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
    description: "Raid Team Stats dark: deep navy, forge-orange, rune teal.",
  },
  anvil: {
    name: "Anvil",
    description: "Raid Team Stats light: warm parchment + steel, forge-orange.",
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

// ─── Custom (user-defined) theme ──────────────────────────────────────────
//
// A custom theme isn't a static [data-theme] CSS block — the user picks a
// handful of anchor colours and we map them onto the full CSS-variable set,
// injected inline at first paint (layout.tsx) so there's no flash. The
// THEME_COOKIE holds the literal "custom"; the palette JSON lives in a
// second cookie.

export const CUSTOM_THEME = "custom" as const;
export const THEME_CUSTOM_COOKIE = "rts-theme-custom";

export type CustomPalette = {
  bg: string;
  surface: string;
  text: string;
  primary: string;
  primaryText: string;
  border: string;
};

/** Editor field metadata — the 6 anchor colours the user picks. */
export const CUSTOM_ANCHORS: ReadonlyArray<{
  key: keyof CustomPalette;
  label: string;
  hint: string;
}> = [
  { key: "bg", label: "Background", hint: "Page background" },
  { key: "surface", label: "Surface", hint: "Cards, popovers, inputs" },
  { key: "text", label: "Text", hint: "Main text colour" },
  { key: "primary", label: "Primary", hint: "Buttons, links, highlights" },
  { key: "primaryText", label: "On primary", hint: "Text on primary buttons" },
  { key: "border", label: "Border", hint: "Lines and dividers" },
];

export const DEFAULT_CUSTOM_PALETTE: CustomPalette = {
  bg: "#0f1117",
  surface: "#1a1d27",
  text: "#e6e8ee",
  primary: "#6ea8fe",
  primaryText: "#0b1020",
  border: "#2a2f3a",
};

const HEX6 = /^#[0-9a-fA-F]{6}$/;
export const isHexColor = (v: unknown): v is string =>
  typeof v === "string" && HEX6.test(v);

/**
 * Parse + STRICTLY validate a stored palette. Every field must be a
 * #rrggbb hex string — anything else returns null (falls back to default).
 * This is the injection guard: only validated hex is ever inlined into the
 * theme <style>/<script>.
 */
export function parseCustomPalette(
  raw: string | undefined | null,
): CustomPalette | null {
  if (!raw) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const keys: (keyof CustomPalette)[] = [
    "bg",
    "surface",
    "text",
    "primary",
    "primaryText",
    "border",
  ];
  const out = {} as CustomPalette;
  for (const k of keys) {
    if (!isHexColor(o[k])) return null;
    out[k] = o[k] as string;
  }
  return out;
}

/**
 * Map an anchor palette onto the full CSS-variable set. Values are all
 * validated hex (or a color-mix of two), so the result is safe to inline.
 */
export function customPaletteToVars(p: CustomPalette): Record<string, string> {
  return {
    "--background": p.bg,
    "--card": p.surface,
    "--popover": p.surface,
    "--foreground": p.text,
    "--card-foreground": p.text,
    "--popover-foreground": p.text,
    "--primary": p.primary,
    "--primary-foreground": p.primaryText,
    "--secondary": p.surface,
    "--secondary-foreground": p.text,
    "--muted": p.surface,
    "--muted-foreground": `color-mix(in srgb, ${p.text} 60%, ${p.bg})`,
    "--accent": p.surface,
    "--accent-foreground": p.text,
    "--ring": p.primary,
    "--border": p.border,
    "--input": p.border,
    "--destructive": "#ef4444",
  };
}

/** Same mapping as a single `--k:v;…` declaration string (for inline JS). */
export function customPaletteToCss(p: CustomPalette): string {
  return Object.entries(customPaletteToVars(p))
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

/** Relative luminance of a #rrggbb → light if bright (skip the .dark class). */
export function isLightHex(hex: string): boolean {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55;
}
