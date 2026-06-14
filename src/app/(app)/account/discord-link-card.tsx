"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Account-page Discord linking. Self-contained: hides entirely when the bot
 * isn't configured on this deployment. Generate a 10-minute code, run
 * `/statsmith link code:<CODE>` in Discord to bind the account.
 */
export function DiscordLinkCard() {
  const status = api.discord.status.useQuery();
  const enabled = status.data?.enabled === true;
  const myLink = api.discord.myLink.useQuery(undefined, { enabled });
  const utils = api.useUtils();
  const [code, setCode] = useState<string | null>(null);

  const create = api.discord.createLinkCode.useMutation({
    onSuccess: (d) => setCode(d.code),
  });
  const unlink = api.discord.unlink.useMutation({
    onSuccess: async () => {
      setCode(null);
      await utils.discord.myLink.invalidate();
    },
  });

  if (!enabled) return null;

  const linked = myLink.data?.linked;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Discord</CardTitle>
        <CardDescription>
          Link Discord so your taps on the raid signup board count as your
          attendance.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          Status:{" "}
          <span className={linked ? "text-green-500" : "text-muted-foreground"}>
            {linked ? "Linked" : "Not linked"}
          </span>
        </p>

        {linked ? (
          <Button
            size="sm"
            variant="outline"
            disabled={unlink.isPending}
            onClick={() => unlink.mutate()}
          >
            {unlink.isPending ? "Unlinking…" : "Unlink Discord"}
          </Button>
        ) : code ? (
          <div className="space-y-2">
            <p className="text-muted-foreground">
              In a server where the Stat Smith bot is installed, run:
            </p>
            <code className="bg-muted block w-fit rounded px-2 py-1 font-mono text-sm">
              /statsmith link code:{code}
            </code>
            <p className="text-muted-foreground text-xs">
              Valid for 10 minutes · single use.
            </p>
          </div>
        ) : (
          <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Generating…" : "Generate link code"}
          </Button>
        )}

        {(create.error || unlink.error) && (
          <p className="text-destructive text-xs" role="alert">
            {(create.error ?? unlink.error)?.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
