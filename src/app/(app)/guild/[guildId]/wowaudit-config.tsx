"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/trpc-client";

type Props = {
  guildId: string;
  canEdit: boolean;
};

export function WowauditConfigCard({ guildId, canEdit }: Props) {
  const utils = api.useUtils();
  const status = api.guild.wowauditStatus.useQuery({ guildId });
  const [apiKey, setApiKey] = useState("");
  const [teamId, setTeamId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [pingResult, setPingResult] = useState<string | null>(null);

  const setConfig = api.guild.setWowauditConfig.useMutation({
    onSuccess: async () => {
      setApiKey("");
      setTeamId("");
      setBaseUrl("");
      await utils.guild.wowauditStatus.invalidate({ guildId });
    },
  });
  const clearConfig = api.guild.clearWowauditConfig.useMutation({
    onSuccess: () => utils.guild.wowauditStatus.invalidate({ guildId }),
  });
  const ping = api.guild.testWowauditConnection.useMutation({
    onSuccess: (data) => {
      setPingResult(data.ok ? "Connection OK." : `Error: ${data.error}`);
    },
    onError: (err) => setPingResult(`Error: ${err.message}`),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPingResult(null);
    setConfig.mutate({
      guildId,
      apiKey,
      teamId: teamId.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>WoW Audit</CardTitle>
        <CardDescription>
          Optional per-guild integration. Paste the team API key from your WoW
          Audit team page (Settings → API). Stored AES-256-GCM encrypted —
          never visible to the platform after save.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {status.isPending ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : status.data?.configured ? (
          <div className="space-y-1">
            <p>
              Status: <span className="text-green-500">Configured</span>
            </p>
            <p className="text-muted-foreground">
              Key hint:{" "}
              <code className="bg-muted/40 rounded px-1">{status.data.keyHint}</code>
            </p>
            {status.data.teamId && (
              <p className="text-muted-foreground">
                Team id:{" "}
                <code className="bg-muted/40 rounded px-1">{status.data.teamId}</code>
              </p>
            )}
            {status.data.baseUrl && (
              <p className="text-muted-foreground">Base URL: {status.data.baseUrl}</p>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground">Not configured.</p>
        )}
        {pingResult && <p className="text-sm">{pingResult}</p>}
        {(setConfig.error || clearConfig.error) && (
          <p className="text-destructive text-sm" role="alert">
            {(setConfig.error ?? clearConfig.error)?.message}
          </p>
        )}
      </CardContent>

      {canEdit && (
        <CardFooter className="flex flex-col items-stretch gap-3">
          {status.data?.configured && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={ping.isPending}
                onClick={() => {
                  setPingResult(null);
                  ping.mutate({ guildId });
                }}
              >
                {ping.isPending ? "Testing…" : "Test connection"}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={clearConfig.isPending}
                onClick={() => clearConfig.mutate({ guildId })}
              >
                {clearConfig.isPending ? "Removing…" : "Remove key"}
              </Button>
            </div>
          )}
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="wowaudit-api-key">API key</Label>
              <Input
                id="wowaudit-api-key"
                type="password"
                placeholder="Paste your WoW Audit team API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="wowaudit-team-id">Team id (optional)</Label>
                <Input
                  id="wowaudit-team-id"
                  type="text"
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wowaudit-base-url">Base URL (optional)</Label>
                <Input
                  id="wowaudit-base-url"
                  type="url"
                  placeholder="https://wowaudit.com/v1"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  spellCheck={false}
                />
              </div>
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={setConfig.isPending || apiKey.length < 8}
            >
              {setConfig.isPending
                ? "Saving…"
                : status.data?.configured
                  ? "Rotate key"
                  : "Save"}
            </Button>
          </form>
        </CardFooter>
      )}
    </Card>
  );
}
