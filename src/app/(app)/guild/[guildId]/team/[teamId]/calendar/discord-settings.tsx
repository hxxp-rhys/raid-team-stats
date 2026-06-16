"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Official Discord help: enabling Developer Mode + copying IDs. VERIFY-QUARTERLY:
// re-check this URL still 200s and covers Developer Mode; next check 2026-09-14.
// Single source of truth for the link lives in the discord-api skill.
const DISCORD_DEV_MODE_HELP =
  "https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID";

/**
 * Per-team Discord binding, shown inside Calendar settings (LEADER only) and
 * only when the bot is configured on the deployment. Bind a guild + channel;
 * the bot posts each raid's signup board there and edits it in place.
 */
export function DiscordSettings({
  raidTeamId,
  canLead,
  onSaved,
  mainHasUnsavedEdits,
}: {
  raidTeamId: string;
  canLead: boolean;
  /** Called after a clean update so the parent can close the modal. */
  onSaved?: () => void;
  /** When the sibling (main) settings form has unsaved edits, we must NOT close. */
  mainHasUnsavedEdits?: boolean;
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
          onSaved={onSaved}
          mainHasUnsavedEdits={mainHasUnsavedEdits}
          initial={q.data?.integration ?? null}
        />
      )}
    </div>
  );
}

function Form({
  raidTeamId,
  canLead,
  onSaved,
  mainHasUnsavedEdits,
  initial,
}: {
  raidTeamId: string;
  canLead: boolean;
  onSaved?: () => void;
  mainHasUnsavedEdits?: boolean;
  initial: {
    guildId: string;
    channelId: string;
    autoPostEnabled: boolean;
    autoPostLeadDays: number;
    requiredRoleId: string | null;
    buttonRoleId: string | null;
  } | null;
}) {
  const utils = api.useUtils();
  const [guildId, setGuildId] = useState(initial?.guildId ?? "");
  const [channelId, setChannelId] = useState(initial?.channelId ?? "");
  const [autoPost, setAutoPost] = useState(initial?.autoPostEnabled ?? false);
  const [leadDays, setLeadDays] = useState(initial?.autoPostLeadDays ?? 5);
  const [linkRoleId, setLinkRoleId] = useState(initial?.requiredRoleId ?? "");
  const [buttonRoleId, setButtonRoleId] = useState(initial?.buttonRoleId ?? "");

  const save = api.discord.setIntegration.useMutation({
    onSuccess: async (data) => {
      await utils.discord.getIntegration.invalidate({ raidTeamId });
      // Close the modal after a clean SAVE (update) — but only when it's safe:
      //  - not a first connect (keep it open so the leader sees the banner),
      //  - commands actually registered (else show the warning), and
      //  - the sibling main form has no unsaved edits (don't discard them).
      if (initial && data.commandsRegistered && !mainHasUnsavedEdits) onSaved?.();
    },
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

  const isRole = (v: string) => v === "" || /^\d{15,22}$/.test(v);
  const rolesValid = isRole(linkRoleId) && isRole(buttonRoleId);
  const valid =
    /^\d{15,22}$/.test(guildId) && /^\d{15,22}$/.test(channelId) && rolesValid;

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

      <div className="border-border/60 space-y-2 border-t pt-2">
        <div className="space-y-1">
          <Label className="text-xs">Link-command role ID (optional)</Label>
          <Input
            value={linkRoleId}
            onChange={(e) => setLinkRoleId(e.target.value.trim())}
            placeholder="right-click a role → Copy ID (blank = anyone can link)"
          />
          <p className="text-muted-foreground text-xs">
            When set, only members with this role can run{" "}
            <span className="font-mono">/statsmith link</span> (server admins
            always can).
          </p>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Signup-button role ID (optional)</Label>
          <Input
            value={buttonRoleId}
            onChange={(e) => setButtonRoleId(e.target.value.trim())}
            placeholder="right-click a role → Copy ID (blank = anyone can sign up)"
          />
          <p className="text-muted-foreground text-xs">
            When set, only members with this role —{" "}
            <strong>or</strong> the link-command role above — can tap the signup
            buttons (admins always can). Leave blank to let anyone sign up.
          </p>
        </div>
        {!rolesValid && (
          <p className="text-destructive text-xs" role="alert">
            That doesn’t look like a Discord role ID.
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          Need the IDs?{" "}
          <a
            href={DISCORD_DEV_MODE_HELP}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2"
          >
            How to enable Developer Mode &amp; copy IDs
          </a>{" "}
          — turn on Developer Mode, then right-click a role to Copy ID.
        </p>
      </div>

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
              requiredRoleId: linkRoleId,
              buttonRoleId,
            })
          }
        >
          {save.isPending ? "Saving…" : initial ? "Save" : "Connect"}
        </Button>
        {initial && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ raidTeamId })}
            >
              Disconnect
            </Button>
            <span
              role="img"
              tabIndex={0}
              aria-label="Disconnect: unlinks this Discord channel — the bot stops posting and updating raid boards. Existing posts stay; this is reversible."
              title="Unlinks this Discord channel — the bot stops posting and updating raid boards. Existing posts stay; this is reversible."
              className="border-border text-muted-foreground inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border text-[10px] font-semibold leading-none"
            >
              i
            </span>
          </>
        )}
      </div>
      {save.data && !save.data.commandsRegistered && (
        <p className="text-amber-500 text-xs">
          Connected, but couldn&apos;t register commands ({save.data.commandError}) —
          make sure the bot is in that server.
        </p>
      )}
      {save.data?.commandsRegistered && (
        <p className="text-green-500 text-xs">
          {initial ? "Saved" : "Connected"} — commands registered. ✓
          {initial && mainHasUnsavedEdits &&
            " You still have unsaved calendar changes above — Save or Cancel them to finish."}
        </p>
      )}
      {(save.error || remove.error) && (
        <p className="text-destructive text-xs" role="alert">
          {(save.error ?? remove.error)?.message}
        </p>
      )}
    </div>
  );
}
