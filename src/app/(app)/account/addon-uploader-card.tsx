"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function relAge(d: Date | string, nowMs: number): string {
  const t = new Date(d).getTime();
  const mins = Math.round((nowMs - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function AddonUploaderCard() {
  const utils = api.useUtils();
  const q = api.account.uploadStatus.useQuery();
  const regen = api.account.regenerateToken.useMutation({
    onSuccess: () => utils.account.uploadStatus.invalidate(),
  });
  const revoke = api.account.revokeToken.useMutation({
    onSuccess: () => utils.account.uploadStatus.invalidate(),
  });
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const [nowMs] = useState(() => Date.now());

  const token = q.data?.token ?? null;
  const uploads = q.data?.uploads ?? [];

  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can select the text manually */
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Live data uploader (Great Vault / Delves)</CardTitle>
        <CardDescription>
          Blizzard exposes no API for the World/Delve Great Vault. Our own
          WoW addon reads it live; a small companion app uploads it. No
          third-party (WoW Audit) dependency.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <div className="space-y-2">
          <a
            href="/uploader/installer"
            className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:opacity-90"
          >
            ⬇ Download Windows installer (.msi)
          </a>
          <p className="text-muted-foreground text-xs">
            The installer bundles everything (no Node needed): pick your WoW
            folder, paste the token below, choose run-at-startup. It installs
            the addon for you and verifies the folder + token before
            finishing. Then in WoW enable the{" "}
            <code className="bg-muted/50 rounded px-1">
              Raid Team Stats Uploader
            </code>{" "}
            addon and{" "}
            <code className="bg-muted/50 rounded px-1">/reload</code> once.
          </p>
          <p className="text-muted-foreground text-xs">
            Advanced / no installer:{" "}
            <a
              href="/uploader/download"
              className="text-primary hover:underline"
            >
              download the addon + companion zip
            </a>{" "}
            and run it manually with Node.
          </p>
        </div>

        <div className="border-border bg-muted/40 space-y-1.5 rounded-md border p-3 text-xs">
          <p className="text-foreground font-medium">
            Before you install — what it does &amp; permissions
          </p>
          <p className="text-muted-foreground">
            This is a tiny background helper. WoW addons can&apos;t use the
            internet, so it reads <em>only</em> your own characters&apos;
            Great Vault / Delve, weekly M+, gear and talent data that the
            in-game addon saves, and uploads it here over HTTPS. It changes
            nothing else and is fully removable from Add/Remove Programs.
          </p>
          <p className="text-muted-foreground">
            <span className="text-foreground font-medium">
              It will ask for Administrator permission.
            </span>{" "}
            That&apos;s expected: Windows protects the Program Files area, so
            admin is needed only to install the helper, copy the addon into
            your World of Warcraft folder, and set up the optional automatic
            background sync.
          </p>
          <p className="text-muted-foreground">
            <span className="text-foreground font-medium">
              Windows may show a blue &ldquo;Windows protected your PC&rdquo;
              / unknown-publisher warning.
            </span>{" "}
            That&apos;s because the installer isn&apos;t code-signed yet (not
            because it&apos;s unsafe). Click{" "}
            <em>More info → Run anyway</em> to proceed. Code signing to remove
            this is planned.
          </p>
        </div>

        <div>
          <p className="text-muted-foreground mb-1 text-xs font-medium uppercase">
            Upload token
          </p>
          {q.isPending ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : token ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="bg-muted/50 min-w-0 flex-1 truncate rounded px-2 py-1 font-mono text-xs">
                {show ? token : "•".repeat(24)}
              </code>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShow((s) => !s)}
              >
                {show ? "Hide" : "Show"}
              </Button>
              <Button type="button" variant="outline" onClick={copy}>
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={regen.isPending}
                onClick={() => regen.mutate()}
                title="Invalidates the old token"
              >
                Regenerate
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate()}
              >
                Revoke
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              disabled={regen.isPending}
              onClick={() => regen.mutate()}
            >
              {regen.isPending ? "Generating…" : "Generate upload token"}
            </Button>
          )}
          <p className="text-muted-foreground mt-1 text-xs">
            Treat this like a password. Regenerating or revoking it stops the
            companion until you update its config.
          </p>
        </div>

        <div>
          <p className="text-muted-foreground mb-1 text-xs font-medium uppercase">
            Recent uploads
          </p>
          {uploads.length === 0 ? (
            <p className="text-muted-foreground">
              No uploads yet — once the companion runs, your characters appear
              here.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground text-left text-xs uppercase">
                  <th className="py-1 pr-3 font-medium">Character</th>
                  <th className="py-1 pr-3 text-right font-medium">World vault</th>
                  <th className="py-1 pr-3 text-right font-medium">M+ runs</th>
                  <th className="py-1 pr-3 text-right font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {uploads.map((u, i) => (
                  <tr key={i}>
                    <td className="py-1.5 pr-3 font-medium">
                      {u.character.name}
                      <span className="text-muted-foreground ml-1 text-xs">
                        {u.character.realmSlug}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {u.worldUnlocked ?? "—"}/{u.worldTotal}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {u.weeklyMplusRuns ?? "—"}
                    </td>
                    <td className="text-muted-foreground py-1.5 pr-3 text-right text-xs">
                      {relAge(u.collectedAt, nowMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
