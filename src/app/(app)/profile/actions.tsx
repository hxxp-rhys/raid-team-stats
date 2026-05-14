"use client";

import { signIn, signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

export function ProfileActions({ battlenetLinked }: { battlenetLinked: boolean }) {
  return (
    <div className="flex flex-wrap gap-3">
      {battlenetLinked ? null : (
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
  );
}
