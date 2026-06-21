"use client";

import Link from "next/link";
import type { Route } from "next";
import { useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";

import { cn } from "@/lib/utils";

type Item =
  | { kind: "link"; label: string; href: string }
  | { kind: "action"; label: string; onSelect: () => void; destructive?: boolean }
  | { kind: "divider" };

export function UserMenu({
  label,
  isAdmin,
}: {
  label: string;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside, Escape, or route change.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // "My guilds" lives in the top bar (left of this menu), not in here.
  const items: Item[] = [
    { kind: "link", label: "Themes", href: "/settings" },
    { kind: "link", label: "Account", href: "/account" },
    ...(isAdmin ? ([{ kind: "link", label: "Admin", href: "/admin" }] as const) : []),
    { kind: "link", label: "About", href: "/about" },
    { kind: "divider" },
    {
      kind: "action",
      label: "Sign out",
      onSelect: () => {
        setOpen(false);
        void signOut({ callbackUrl: "/" });
      },
    },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="border-border bg-background hover:bg-muted inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors"
      >
        <span
          className="bg-primary text-primary-foreground inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold"
          aria-hidden
        >
          {label.slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden sm:inline">{label}</span>
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className={cn("size-3 transition-transform", open && "rotate-180")}
        >
          <path
            d="M5 7l5 6 5-6"
            stroke="currentColor"
            strokeWidth="2"
            fill="none"
          />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="User menu"
          className="border-border bg-card absolute right-0 z-50 mt-2 w-52 overflow-hidden rounded-lg border shadow-lg"
        >
          <ul className="py-1 text-sm">
            {items.map((item, i) => {
              if (item.kind === "divider") {
                return (
                  <li key={`d-${i}`} className="border-border my-1 border-t" aria-hidden />
                );
              }
              if (item.kind === "link") {
                return (
                  <li key={item.label}>
                    <Link
                      href={item.href as Route}
                      role="menuitem"
                      onClick={() => setOpen(false)}
                      className="hover:bg-muted block px-3 py-2"
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              }
              return (
                <li key={item.label}>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={item.onSelect}
                    className={cn(
                      "hover:bg-muted block w-full px-3 py-2 text-left",
                      item.destructive && "text-destructive",
                    )}
                  >
                    {item.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
