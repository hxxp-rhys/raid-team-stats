import type { ReactNode } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Common widget chrome: title, optional description, content slot. Keeps
 * spacing and edge styling consistent across the dashboard grid.
 */
export function WidgetShell({
  title,
  description,
  requiresCompanion,
  headerAction,
  children,
}: {
  title: string;
  description?: string;
  /** Show a small "Stat Smith addon required" chip in the header for
   *  widgets whose data comes only from the in-game addon/companion. */
  requiresCompanion?: boolean;
  /** Optional action rendered top-right, inline with the title (e.g. a button
   *  that opens a detail lightbox). */
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  // h-full so the card stretches to fill its (resizable) grid cell; the
  // content region grows + scrolls instead of leaving empty space below.
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          <div className="flex shrink-0 items-center gap-2">
            {requiresCompanion && (
              <span
                className="border-border bg-muted/50 text-muted-foreground rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium"
                title="This widget's data comes from the Stat Smith in-game addon + companion uploader."
              >
                Stat Smith required
              </span>
            )}
            {headerAction}
          </div>
        </div>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-auto">
        {children}
      </CardContent>
    </Card>
  );
}

export function WidgetEmpty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

export function WidgetLoading() {
  return <p className="text-muted-foreground text-sm">Loading…</p>;
}

export function WidgetError({ message }: { message: string }) {
  return (
    <p className="text-destructive text-sm" role="alert">
      {message}
    </p>
  );
}
