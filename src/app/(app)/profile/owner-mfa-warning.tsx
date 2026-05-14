"use client";

import Link from "next/link";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/trpc-client";

/**
 * Surfaces an amber warning on /profile when the caller is a guild OWNER
 * (in any guild) but has not enabled MFA. Strictly informational — the
 * MFA-gating on promotions is enforced server-side; this card just nudges
 * the user before they're stuck unable to delegate.
 */
export function OwnerMfaWarning() {
  const guilds = api.guild.myGuilds.useQuery();
  const mfa = api.mfa.status.useQuery();

  if (guilds.isPending || mfa.isPending) return null;
  const ownerOfAny = !!guilds.data?.some(
    (m) => m.role === "OWNER" && m.status === "ACTIVE",
  );
  if (!ownerOfAny || mfa.data?.enabled) return null;

  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="text-amber-400">Enable 2FA</CardTitle>
        <CardDescription>
          You&apos;re the owner of at least one guild. The platform requires
          guild OWNERs to have two-factor authentication enabled before they
          can promote another member to OWNER (or accept ownership of any
          guild going forward).
        </CardDescription>
      </CardHeader>
      <CardContent className="text-muted-foreground text-sm">
        Scroll down to <Link href="#mfa" className="text-primary underline-offset-4 hover:underline">Two-factor authentication</Link> to set
        it up.
      </CardContent>
    </Card>
  );
}
