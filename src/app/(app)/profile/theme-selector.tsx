"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { THEME_IDS, THEME_META, type ThemeId } from "@/lib/theme";
import { setThemeAction } from "./theme-actions";

export function ThemeSelector({ current }: { current: ThemeId }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<ThemeId>(current);

  const apply = (id: ThemeId) => {
    setSelected(id);
    startTransition(async () => {
      const r = await setThemeAction(id);
      if (r.ok) router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Theme</CardTitle>
        <CardDescription>
          Change the site palette. Applies across every page; saved in a
          cookie so it follows you around. Refresh if a tab keeps a stale
          theme.
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
                  onClick={() => apply(id)}
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
        </ul>
      </CardContent>
    </Card>
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
