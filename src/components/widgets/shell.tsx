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
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  // h-full so the card stretches to fill its (resizable) grid cell; the
  // content region grows + scrolls instead of leaving empty space below.
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
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
