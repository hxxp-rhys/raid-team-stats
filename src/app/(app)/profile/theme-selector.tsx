"use client";

import { useState, useTransition, type CSSProperties } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  CUSTOM_ANCHORS,
  CUSTOM_THEME,
  customPaletteToCss,
  customPaletteToVars,
  isLightHex,
  isLightTheme,
  THEME_IDS,
  THEME_META,
  type CustomPalette,
  type ThemeId,
} from "@/lib/theme";
import { cn } from "@/lib/utils";
import { setCustomThemeAction, setThemeAction } from "./theme-actions";

type Current = ThemeId | typeof CUSTOM_THEME;

export function ThemeSelector({
  current,
  customPalette,
}: {
  current: Current;
  customPalette: CustomPalette;
}) {
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Current>(current);
  const [palette, setPalette] = useState<CustomPalette>(customPalette);

  // Apply the theme to the live document immediately. The cookie (set by
  // the server action) only takes effect via the layout's inline
  // ThemeScript, and inline scripts do NOT re-execute on router.refresh()
  // — RSC reconciliation swaps the script node's text but the browser
  // never re-runs it. Without this direct DOM application the new theme
  // only appeared after a full reload.
  const applyBuiltinToDom = (id: ThemeId) => {
    const el = document.documentElement;
    el.setAttribute("data-theme", id);
    // A previously-applied custom theme injects inline CSS vars on <html>
    // that would override the [data-theme] block — clear them.
    el.removeAttribute("style");
    el.classList.toggle("dark", !isLightTheme(id));
  };
  const applyCustomToDom = (p: CustomPalette) => {
    const el = document.documentElement;
    el.setAttribute("data-theme", CUSTOM_THEME);
    el.style.cssText = customPaletteToCss(p);
    el.classList.toggle("dark", !isLightHex(p.bg));
  };

  const applyBuiltin = (id: ThemeId) => {
    setSelected(id);
    // Optimistic: paint the new theme synchronously in the click handler —
    // the cookie write is for FUTURE loads and must never gate the visible
    // change. Re-asserted after the action so the server round-trip (and
    // its revalidation) can't end on a different state.
    applyBuiltinToDom(id);
    startTransition(async () => {
      const r = await setThemeAction(id);
      if (r.ok) applyBuiltinToDom(id);
    });
  };

  const applyCustom = () => {
    setSelected(CUSTOM_THEME);
    applyCustomToDom(palette);
    startTransition(async () => {
      const r = await setCustomThemeAction(palette);
      if (r.ok) applyCustomToDom(palette);
    });
  };

  // Custom CSS variables for the live preview surfaces. Cast through unknown
  // because the `--x` keys aren't in the CSSProperties index. `colorScheme`
  // matches the palette's light/dark nature so native controls + scrollbars
  // in the preview render consistently regardless of the editor's own theme.
  const customIsLight = isLightHex(palette.bg);
  const previewStyle = {
    ...customPaletteToVars(palette),
    colorScheme: customIsLight ? "light" : "dark",
  } as unknown as CSSProperties;
  // `.dark` on the preview wrapper makes any `dark:`-variant utilities inside
  // it match the custom theme, mirroring how applying the theme toggles the
  // class on <html>.
  const previewDarkClass = customIsLight ? undefined : "dark";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Theme</CardTitle>
          <CardDescription>
            Change the site palette. Applies instantly and across every page;
            saved in a cookie so it follows you around. Other already-open
            tabs pick it up on their next load.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {THEME_IDS.map((id) => {
              const meta = THEME_META[id];
              const isActive = selected === id;
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => applyBuiltin(id)}
                    aria-pressed={isActive}
                    disabled={pending && selected === id}
                    className={`relative w-full rounded-lg border p-3 text-left transition-colors ${
                      isActive
                        ? "border-primary bg-muted"
                        : "border-border bg-background hover:bg-muted/40"
                    }`}
                  >
                    <ThemePreview themeId={id} />
                    <p className="mt-2 text-sm font-medium">{meta.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {meta.description}
                    </p>
                    {isActive && (
                      <span className="text-primary absolute right-2 top-2 text-xs">
                        ●
                      </span>
                    )}
                  </button>
                </li>
              );
            })}

            {/* Custom tile — selects custom + reveals the editor below. */}
            <li>
              <button
                type="button"
                onClick={() => setSelected(CUSTOM_THEME)}
                aria-pressed={selected === CUSTOM_THEME}
                className={`relative w-full rounded-lg border p-3 text-left transition-colors ${
                  selected === CUSTOM_THEME
                    ? "border-primary bg-muted"
                    : "border-border bg-background hover:bg-muted/40"
                }`}
              >
                <div
                  data-theme="custom"
                  style={previewStyle}
                  className={cn(
                    "border-border flex h-10 overflow-hidden rounded-md border",
                    previewDarkClass,
                  )}
                >
                  <div className="bg-background flex-1" />
                  <div className="bg-card flex-1" />
                  <div className="bg-primary flex-1" />
                </div>
                <p className="mt-2 text-sm font-medium">Custom</p>
                <p className="text-muted-foreground text-xs">
                  Build your own palette.
                </p>
                {selected === CUSTOM_THEME && (
                  <span className="text-primary absolute right-2 top-2 text-xs">
                    ●
                  </span>
                )}
              </button>
            </li>
          </ul>
        </CardContent>
      </Card>

      {selected === CUSTOM_THEME && (
        <Card>
          <CardHeader>
            <CardTitle>Custom palette</CardTitle>
            <CardDescription>
              Pick your colours, preview live, then apply. We map these onto
              the full set of UI colours.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {CUSTOM_ANCHORS.map((a) => (
                <label
                  key={a.key}
                  className="flex items-center gap-3"
                  htmlFor={`color-${a.key}`}
                >
                  <input
                    id={`color-${a.key}`}
                    type="color"
                    value={palette[a.key]}
                    onChange={(e) =>
                      setPalette((p) => ({ ...p, [a.key]: e.target.value }))
                    }
                    className="border-border size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
                    aria-label={a.label}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{a.label}</span>
                    <span className="text-muted-foreground block text-xs">
                      {a.hint} · {palette[a.key]}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            {/* Live preview — a mini surface rendered with the palette. */}
            <div
              data-theme="custom"
              style={previewStyle}
              className={cn(
                "border-border bg-background text-foreground space-y-2 rounded-lg border p-4",
                previewDarkClass,
              )}
            >
              <p className="font-medium">Preview</p>
              <p className="text-muted-foreground text-sm">
                Muted text looks like this.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 text-xs font-medium">
                  Primary button
                </span>
                <span className="border-border bg-card rounded-md border px-2.5 py-1 text-xs">
                  Card surface
                </span>
              </div>
            </div>

            <Button type="button" onClick={applyCustom} disabled={pending}>
              {pending ? "Applying…" : "Apply custom theme"}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * Small palette swatch — three vertical bars showing background / card /
 * primary for the given theme. Rendered with `data-theme` on the wrapper so
 * the previewed colors actually come from the CSS variables, not duplicated
 * hex codes that could drift.
 */
function ThemePreview({ themeId }: { themeId: ThemeId }) {
  return (
    <div
      data-theme={themeId}
      className="flex h-10 overflow-hidden rounded-md border border-border"
    >
      <div className="bg-background flex-1" />
      <div className="bg-card flex-1" />
      <div className="bg-primary flex-1" />
    </div>
  );
}
