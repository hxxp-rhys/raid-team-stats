"use client";

import { useEffect, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Lightweight modal (lightbox-style overlay). Click-outside and Escape
 * dismiss. Not Radix-based — kept dependency-light. The body element has
 * `overflow: hidden` while open so the page underneath doesn't scroll.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
  hideDefaultFooter = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
  /** Hide the built-in footer "Close" — for modals that supply their own
   *  dismiss action (e.g. a form's Cancel/Save) so there's only one. */
  hideDefaultFooter?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <div
        className={cn(
          "border-border bg-card text-foreground w-full max-w-2xl overflow-hidden rounded-lg border shadow-2xl",
          className,
        )}
      >
        {(title || description) && (
          <header className="border-border space-y-1 border-b px-5 py-4">
            {title && (
              <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            )}
            {description && (
              <p className="text-muted-foreground text-sm">{description}</p>
            )}
          </header>
        )}
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {!hideDefaultFooter && (
          <footer className="border-border bg-muted/30 flex justify-end gap-2 border-t px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="border-border bg-background hover:bg-muted text-foreground inline-flex h-8 items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors"
            >
              Close
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
