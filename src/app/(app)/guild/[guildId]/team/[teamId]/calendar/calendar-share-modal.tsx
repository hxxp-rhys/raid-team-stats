"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { ShareExpiryRadios } from "@/components/share-expiry-radios";
import { DEFAULT_SHARE_EXPIRY_DAYS } from "@/lib/share-expiry";

/**
 * Share the team calendar via a signed read-only link, mirroring the dashboard
 * share UX: choose a link lifetime, generate + copy, and toggle whether the
 * link is publicly viewable (anonymous read) or members-only. The link opens
 * the view (agenda/month) that was selected when it was created.
 */
export function CalendarShareModal({
  raidTeamId,
  view,
  open,
  onClose,
}: {
  raidTeamId: string;
  view: "agenda" | "month";
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share calendar"
      description={`Creates a read-only link that opens the ${view} view.`}
      hideDefaultFooter
    >
      {open && <Body raidTeamId={raidTeamId} view={view} />}
    </Modal>
  );
}

function Body({
  raidTeamId,
  view,
}: {
  raidTeamId: string;
  view: "agenda" | "month";
}) {
  const utils = api.useUtils();
  const [expiryDays, setExpiryDays] = useState<number | null>(
    DEFAULT_SHARE_EXPIRY_DAYS,
  );
  const [url, setUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);

  const settings = api.calendar.calendarShareSettings.useQuery({ raidTeamId });
  const setPublic = api.calendar.setCalendarSharePublic.useMutation({
    onSuccess: () =>
      utils.calendar.calendarShareSettings.invalidate({ raidTeamId }),
  });
  const create = api.calendar.createCalendarShareLink.useMutation({
    onSuccess: (data) => {
      setUrl(data.url);
      setExpiresAt(data.expiresAt ? new Date(data.expiresAt) : null);
      setCopied(false);
    },
  });

  const onCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (insecure context) — leave the link visible to copy by hand.
    }
  };

  const isPublic = settings.data?.isPublic ?? false;

  return (
    <div className="space-y-4 text-sm">
      <div className="bg-muted/30 rounded-md border p-2">
        <ShareExpiryRadios
          value={expiryDays}
          onChange={setExpiryDays}
          disabled={create.isPending}
        />
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={create.isPending}
        onClick={() => create.mutate({ raidTeamId, view, ttlDays: expiryDays })}
      >
        {create.isPending
          ? "Generating…"
          : url
            ? "Create another link"
            : "Create share link"}
      </Button>
      {create.error && (
        <p className="text-destructive text-xs" role="alert">
          {create.error.message}
        </p>
      )}
      {url && (
        <div className="bg-muted/30 space-y-1 rounded-md border p-2 text-xs">
          <p className="text-muted-foreground">
            {expiresAt
              ? `Expires ${expiresAt.toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}. `
              : "Never expires. "}
            Opens the {view} view.
          </p>
          <div className="flex items-center gap-2">
            <code className="bg-background flex-1 truncate rounded px-2 py-1">
              {url}
            </code>
            <Button size="xs" variant="outline" onClick={onCopy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}

      <div className="border-border space-y-1 rounded-md border p-3">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="accent-primary mt-0.5 h-4 w-4"
            checked={isPublic}
            disabled={settings.isPending || setPublic.isPending}
            onChange={(e) =>
              setPublic.mutate({ raidTeamId, isPublic: e.target.checked })
            }
          />
          <span>
            <span className="font-medium">Publicly viewable</span>
            <span className="text-muted-foreground block text-xs">
              Anyone with the link can view the calendar — no sign-in required.
              Read-only: event times, titles, target raids and attendance
              counts; no member names or per-person data. Off: only signed-in
              team members can open the link.
            </span>
          </span>
        </label>
        {setPublic.error && (
          <p className="text-destructive text-xs" role="alert">
            {setPublic.error.message}
          </p>
        )}
      </div>
    </div>
  );
}
