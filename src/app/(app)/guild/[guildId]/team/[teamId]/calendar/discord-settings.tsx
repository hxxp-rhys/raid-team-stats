"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Per-team Discord binding, shown inside Calendar settings (LEADER only) and
 * only when the bot is configured on the deployment. Bind a guild + channel;
 * the bot posts each raid's signup board there and edits it in place.
 */
export function DiscordSettings({
  raidTeamId,
  canLead,
}: {
  raidTeamId: string;
  canLead: boolean;
}) {
  const status = api.discord.status.useQuery();
  const enabled = status.data?.enabled === true;
  const q = api.discord.getIntegration.useQuery({ raidTeamId }, { enabled });

  if (!enabled) return null;

  return (
    <div className="border-border border-t pt-3">
      <p className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">
        Discord
      </p>
      {q.isPending ? (
        <p className="text-muted-foreground text-xs">Loading…</p>
      ) : (
        <Form
          // Keyed by team (stable across the first save) so the command-
          // registration banner isn't unmounted when the post-save refetch
          // flips `integration` from null to the saved binding.
          key={raidTeamId}
          raidTeamId={raidTeamId}
          canLead={canLead}
          initial={q.data?.integration ?? null}
        />
      )}
    </div>
  );
}

function Form({
  raidTeamId,
  canLead,
  initial,
}: {
  raidTeamId: string;
  canLead: boolean;
  initial: {
    guildId: string;
    channelId: string;
    autoPostEnabled: boolean;
    autoPostLeadDays: number;
  } | null;
}) {
  const utils = api.useUtils();
  const [guildId, setGuildId] = useState(initial?.guildId ?? "");
  const [channelId, setChannelId] = useState(initial?.channelId ?? "");
  const [autoPost, setAutoPost] = useState(initial?.autoPostEnabled ?? false);
  const [leadDays, setLeadDays] = useState(initial?.autoPostLeadDays ?? 5);

  const save = api.discord.setIntegration.useMutation({
    onSuccess: () => void utils.discord.getIntegration.invalidate({ raidTeamId }),
  });
  const remove = api.discord.removeIntegration.useMutation({
    onSuccess: () => void utils.discord.getIntegration.invalidate({ raidTeamId }),
  });

  if (!canLead) {
    return (
      <p className="text-muted-foreground text-xs">
        {initial ? "Posting raid boards to a Discord channel." : "Not connected."}{" "}
        Only the team leader can change this.
      </p>
    );
  }

  const valid = /^\d{15,22}$/.test(guildId) && /^\d{15,22}$/.test(channelId);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Server ID</Label>
          <Input value={guildId} onChange={(e) => setGuildId(e.target.value.trim())} placeholder="right-click server → Copy ID" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Channel ID</Label>
          <Input value={channelId} onChange={(e) => setChannelId(e.target.value.trim())} placeholder="right-click channel → Copy ID" />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Install the bot, enable Discord Developer Mode, then copy the server +
        channel IDs. Use the “Post to Discord” button on a raid to post its board.
      </p>

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={autoPost}
          onChange={(e) => setAutoPost(e.target.checked)}
          className="accent-primary h-4 w-4"
        />
        Auto-post upcoming raids
      </label>
      {autoPost && (
        <div className="flex items-center gap-2 pl-6 text-xs">
          <span className="text-muted-foreground">Post each raid</span>
          <Input
            type="number"
            min={1}
            max={60}
            value={leadDays}
            onChange={(e) => setLeadDays(Math.max(1, Math.min(60, Number(e.target.value) || 5)))}
            className="h-7 w-16"
          />
          <span className="text-muted-foreground">day(s) before it starts.</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={save.isPending || !valid}
          onClick={() =>
            save.mutate({
              raidTeamId,
              guildId,
              channelId,
              autoPostEnabled: autoPost,
              autoPostLeadDays: leadDays,
            })
          }
        >
          {save.isPending ? "Saving…" : initial ? "Update" : "Connect"}
        </Button>
        {initial && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ raidTeamId })}
          >
            Disconnect
          </Button>
        )}
      </div>
      {save.data && !save.data.commandsRegistered && (
        <p className="text-amber-500 text-xs">
          Connected, but couldn&apos;t register commands ({save.data.commandError}) —
          make sure the bot is in that server.
        </p>
      )}
      {save.data?.commandsRegistered && (
        <p className="text-green-500 text-xs">Connected — commands registered. ✓</p>
      )}
      {(save.error || remove.error) && (
        <p className="text-destructive text-xs" role="alert">
          {(save.error ?? remove.error)?.message}
        </p>
      )}
    </div>
  );
}
