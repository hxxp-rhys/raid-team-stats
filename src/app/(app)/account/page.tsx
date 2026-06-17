import { redirect } from "next/navigation";
import type { Session } from "next-auth";

import { auth } from "@/server/auth";
import { db } from "@/lib/db";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ProfileActions, SignOutButton } from "@/app/(app)/profile/actions";
import { MfaCard } from "@/app/(app)/profile/mfa-card";
import { DeleteAccountCard } from "@/app/(app)/profile/delete-account-card";
import { OwnerMfaWarning } from "@/app/(app)/profile/owner-mfa-warning";
import { AddonUploaderCard } from "@/app/(app)/account/addon-uploader-card";
import { AccountRefreshButton } from "@/app/(app)/account/account-refresh-button";
import { DiscordLinkCard } from "@/app/(app)/account/discord-link-card";

export default async function AccountPage() {
  const session =
    (await (auth as unknown as () => Promise<Session | null>)()) ?? null;
  if (!session?.user?.id) {
    redirect("/signin?callbackUrl=/account");
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      emailVerified: true,
      mfaEnabled: true,
      createdAt: true,
      accounts: {
        where: { provider: "battlenet" },
        select: { provider: true, providerAccountId: true },
      },
    },
  });

  if (!user) {
    redirect("/signin");
  }

  const battlenetLinked = user.accounts.length > 0;

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
          <p className="text-muted-foreground text-sm">
            Manage your sign-in details, linked Battle.net account, and 2FA.
          </p>
        </div>
        {/* Sign out — right-hand side of the header. */}
        <SignOutButton />
      </header>

      <div className="space-y-6">
        <OwnerMfaWarning />

        <Card>
          <CardHeader>
            {/* Resync (re-sync THIS account's characters) sits top-right of
                the Account card. */}
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1.5">
                <CardTitle>Account</CardTitle>
                <CardDescription>Your sign-in details.</CardDescription>
              </div>
              <AccountRefreshButton />
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Display name" value={user.displayName ?? "—"} />
            <Row
              label="Email"
              value={user.email ?? "Not set (Battle.net sign-in)"}
            />
            <Row
              label="Email verified"
              value={user.emailVerified ? "Yes" : "Not yet"}
            />
            <Row
              label="Two-factor auth"
              value={user.mfaEnabled ? "Enabled" : "Disabled"}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Battle.net</CardTitle>
            <CardDescription>
              Link to discover your guild and characters. Required before you can
              join a raid team.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProfileActions battlenetLinked={battlenetLinked} />
          </CardContent>
        </Card>

        <DiscordLinkCard />

        <MfaCard />

        <AddonUploaderCard />

        <DeleteAccountCard />
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground font-medium">{value}</span>
    </div>
  );
}
