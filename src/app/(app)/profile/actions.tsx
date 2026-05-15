"use client";

import { useEffect, useRef, useState } from "react";
import { signIn, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/trpc-client";

export function ProfileActions({ battlenetLinked }: { battlenetLinked: boolean }) {
  const router = useRouter();
  const discover = api.guild.discoverFromBattlenet.useMutation({
    onSuccess: () => router.push("/guild"),
  });

  // Detect the "just finished first link" redirect from the signIn callback
  // (?bnet=linked) and auto-run discovery once. The flag is stripped from the
  // URL after firing so navigation/refresh can't re-trigger it.
  // Reading window.location.search via useState avoids Next 16
  // cacheComponents' useSearchParams-needs-Suspense gotcha.
  const [justLinked] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("bnet") === "linked";
  });
  const autoFired = useRef(false);

  useEffect(() => {
    if (!justLinked || autoFired.current) return;
    if (!battlenetLinked) return;
    autoFired.current = true;
    // Strip the query param so a reload doesn't re-trigger.
    window.history.replaceState(null, "", "/profile");
    discover.mutate();
  }, [justLinked, battlenetLinked, discover]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {battlenetLinked ? (
          <>
            <Button
              onClick={() => discover.mutate()}
              disabled={discover.isPending}
              variant="default"
            >
              {discover.isPending ? "Discovering…" : "Discover guilds from Battle.net"}
            </Button>
            <Link
              href="/guild"
              className="border-border bg-background hover:bg-muted inline-flex h-8 items-center justify-center rounded-lg border px-2.5 text-sm font-medium transition-colors"
            >
              My guilds
            </Link>
          </>
        ) : (
          <Button
            onClick={() => signIn("battlenet", { callbackUrl: "/profile" })}
            variant="default"
          >
            Link Battle.net
          </Button>
        )}
        <Button variant="outline" onClick={() => signOut({ callbackUrl: "/" })}>
          Sign out
        </Button>
      </div>
      {discover.error && (
        <p className="text-destructive text-sm" role="alert">
          {discover.error.message}
        </p>
      )}
      {discover.data && (
        <p className="text-muted-foreground text-sm">
          Observed {discover.data.charactersObserved} character
          {discover.data.charactersObserved === 1 ? "" : "s"}, matched{" "}
          {discover.data.guildsMatched} guild
          {discover.data.guildsMatched === 1 ? "" : "s"}.
        </p>
      )}
    </div>
  );
}
