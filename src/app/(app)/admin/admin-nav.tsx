"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/guilds", label: "Guilds" },
  { href: "/admin/audit", label: "Audit log" },
  { href: "/admin/queues", label: "Queues" },
  { href: "/admin/monitoring", label: "Monitoring" },
  { href: "/admin/security", label: "Security" },
  // Settings is always pinned to the far right (ml-auto below).
  { href: "/admin/settings", label: "Settings" },
] as const;

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Admin sections"
      className="border-border mb-6 flex flex-wrap gap-1 border-b"
    >
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "border-b-2 px-3 py-2 text-sm transition-colors -mb-px",
              t.href === "/admin/settings" && "ml-auto",
              active
                ? "border-primary text-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
