import type { ReactNode } from "react";
import Link from "next/link";
import { env } from "@/env";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-12">
      <Link
        href="/"
        className="text-muted-foreground hover:text-foreground mb-6 self-center text-sm transition-colors"
      >
        ← {env.NEXT_PUBLIC_APP_NAME}
      </Link>
      {children}
    </main>
  );
}
