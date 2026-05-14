"use client";

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
