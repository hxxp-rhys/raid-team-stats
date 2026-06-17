"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { api } from "@/lib/trpc-client";
import type { RouterOutputs } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";

type GuildSync = { guildId: string; name: string; jobId: string };

type Candidate = RouterOutputs["guild"]["discoverGuildCandidates"]["candidates"][number];

// Faux-progress copy: discovery is a single round-trip on the wire, but it
// fans out to many Blizzard calls server-side, so showing rotating phases
// reassures the user it's still working rather than frozen.
const SEARCH_STEPS = [
  "Reading your Battle.net characters…",
  "Looking up their guilds…",
  "Checking which you've already added…",
] as const;

/**
 * "Add Guild" lightbox. Two-step, fully server-derived:
 *   1) On open it runs `guild.discoverGuildCandidates` (observe the caller's
 *      Battle.net characters; ZERO writes) and lists the distinct guilds.
 *   2) The user ticks which to add; "Add selected" calls
 *      `guild.addDiscoveredGuilds` which RE-derives from OAuth and adds only
 *      the ticked guilds (the keys are a filter, never trusted as input).
 *
 * The view is driven by an explicit `phase` set from the mutation's
 * onSuccess/onError callbacks (NOT by reading `isPending`), so a fast error
 * can never leave it stuck on the loading text.
 */
export function AddGuildModal({ onClose }: { onClose: () => void }) {
  const utils = api.useUtils();
  const [phase, setPhase] = useState<"loading" | "error" | "ready">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<{
    added: number;
    syncs: GuildSync[];
  } | null>(null);
  const [stepIndex, setStepIndex] = useState(0);

  const discover = api.guild.discoverGuildCandidates.useMutation({
    onMutate: () => {
      setPhase("loading");
      setErrorMsg(null);
      setStepIndex(0);
    },
    onSuccess: (res) => {
      setCandidates(res.candidates);
      setSelected(new Set());
      setPhase("ready");
    },
    onError: (err) => {
      setErrorMsg(err.message);
      setPhase("error");
    },
  });

  const add = api.guild.addDiscoveredGuilds.useMutation({
    onSuccess: async (res) => {
      await utils.guild.myGuilds.invalidate();
      setDone({ added: res.added, syncs: res.syncs ?? [] });
    },
  });

  // Fire discovery exactly once on open. The ref guard keeps Strict Mode's
  // dev double-invoke to a single call.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    discover.mutate();
  }, [discover]);

  // Rotate the faux-progress label while loading.
  useEffect(() => {
    if (phase !== "loading") return;
    const id = window.setInterval(() => {
      setStepIndex((i) => (i + 1 < SEARCH_STEPS.length ? i + 1 : i));
    }, 2500);
    return () => window.clearInterval(id);
  }, [phase]);

  const addable = candidates.filter((c) => !c.alreadyMember);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a guild"
      description="We look up the guilds your Battle.net characters belong to. Tick the ones you want to track — nothing is added unless you select it."
      hideDefaultFooter
    >
      {done ? (
        <div className="space-y-4 text-sm">
          <p className="text-foreground">
            {done.added === 0
              ? "No new guilds were added."
              : `Added ${done.added} guild${done.added === 1 ? "" : "s"}. They now appear in your guild list.`}
          </p>
          {done.syncs.length > 0 && (
            <div className="space-y-3">
              <p className="text-muted-foreground text-xs">
                Syncing roster + data from Battle.net and Warcraft Logs. You can
                close this — it keeps running in the background.
              </p>
              {done.syncs.map((sy) => (
                <GuildSyncProgress
                  key={sy.jobId}
                  guildId={sy.guildId}
                  jobId={sy.jobId}
                  name={sy.name}
                />
              ))}
            </div>
          )}
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : phase === "loading" ? (
        <div
          className="text-muted-foreground flex items-center gap-2 text-sm"
          role="status"
          aria-live="polite"
        >
          <span
            className="border-muted border-t-foreground inline-block size-3 animate-spin rounded-full border-2"
            aria-hidden
          />
          <span>{SEARCH_STEPS[stepIndex]}</span>
        </div>
      ) : phase === "error" ? (
        <div className="space-y-3 text-sm">
          <p className="text-destructive" role="alert">
            {errorMsg ?? "Something went wrong looking up your guilds."}
          </p>
          <p className="text-muted-foreground">
            Guild discovery needs a current Battle.net connection. Open your{" "}
            <Link
              href={"/account" as Route}
              className="text-primary underline-offset-4 hover:underline"
            >
              account page
            </Link>{" "}
            and click <strong>Link Battle.net</strong> (or{" "}
            <strong>Refresh Battle.net</strong> if it&apos;s already linked but
            expired), then try again.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => discover.mutate()}
            >
              Try again
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : candidates.length === 0 ? (
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            No guilds found for your Battle.net characters. If you just joined
            one, it can take Blizzard a little while to show it.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => discover.mutate()}
            >
              Search again
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <ul className="divide-border divide-y">
            {candidates.map((c) => (
              <li
                key={c.key}
                className="flex items-center justify-between gap-3 py-2"
              >
                <label className="flex flex-1 items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={c.alreadyMember || selected.has(c.key)}
                    disabled={c.alreadyMember || add.isPending}
                    onChange={() => toggle(c.key)}
                    className="size-4 shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-muted-foreground ml-2 text-xs">
                      {c.region} · {c.realmSlug} · {c.faction.toLowerCase()}
                    </span>
                    {c.isGuildMaster && !c.alreadyMember && (
                      <span className="ml-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                        You are GM — adding claims ownership
                      </span>
                    )}
                  </span>
                </label>
                {c.alreadyMember && (
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {c.membershipStatus === "PENDING"
                      ? "Pending approval"
                      : "Already added"}
                  </span>
                )}
              </li>
            ))}
          </ul>

          {add.error && (
            <p className="text-destructive text-sm" role="alert">
              {add.error.message}
            </p>
          )}

          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">
              {addable.length === 0
                ? "You're already in all of these."
                : `${selected.size} of ${addable.length} selected`}
            </p>
            <Button
              type="button"
              disabled={selected.size === 0 || add.isPending}
              onClick={() => add.mutate({ guildKeys: [...selected] })}
            >
              {add.isPending ? "Adding…" : "Add selected"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// Phase labels mirror the guild-settings "Refresh Roster" progress UI so the
// two surfaces read identically.
const SYNC_PHASE_LABEL: Record<string, string> = {
  roster: "Fetching roster from Battle.net…",
  members: "Syncing characters…",
  verifying: "Matching + verifying characters…",
  done: "Finishing up…",
};

/**
 * Live progress bar for one freshly-added guild's auto-sync. Polls
 * `manualSyncStatus` every 2s until the job reaches a terminal state, then
 * stops. Same determinate bar + phase labels as the "Refresh Roster" button.
 */
function GuildSyncProgress({
  guildId,
  jobId,
  name,
}: {
  guildId: string;
  jobId: string;
  name: string;
}) {
  const status = api.guild.manualSyncStatus.useQuery(
    { guildId, jobId },
    {
      refetchInterval: (q) => {
        const s = q.state.data?.state;
        if (!s) return 2000;
        return s === "completed" || s === "failed" || s === "unknown"
          ? false
          : 2000;
      },
      refetchOnWindowFocus: false,
    },
  );

  // `status.data` is a discriminated union: the full job shape OR
  // `{ state: "unknown" }` (foreign/expired jobId). Read `progress` /
  // `failedReason` only inside a state-narrowed branch — the `const s` alias
  // lets TS narrow `data` to the full variant (same pattern as the guild-
  // settings "Refresh Roster" button).
  const data = status.data;
  let pct: number | null = null;
  let label = "Queued…";
  if (data) {
    const s = data.state;
    if (s === "active") {
      const prog = data.progress;
      if (prog && prog.total > 0) {
        pct = Math.min(100, Math.round((prog.processed / prog.total) * 100));
        const ph = SYNC_PHASE_LABEL[prog.phase] ?? "Syncing…";
        label =
          prog.phase === "members"
            ? `${ph} ${prog.processed}/${prog.total}`
            : ph;
      } else {
        label = "Fetching roster + matching characters…";
      }
    } else if (s === "waiting" || s === "delayed" || s === "paused") {
      label = "Waiting for the worker to pick it up…";
    } else if (s === "completed") {
      pct = 100;
      label = "Done ✓";
    } else if (s === "failed") {
      label = `Failed: ${data.failedReason ?? "unknown error"}`;
    }
  }
  const done = data?.state === "completed";
  const failed = data?.state === "failed";
  // Indeterminate sliver while we have no percentage yet, so the bar reads as
  // "working" rather than empty.
  const width = pct ?? (data?.state === "active" ? 10 : 5);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{name}</span>
        <span className={failed ? "text-destructive" : "text-muted-foreground"}>
          {label}
        </span>
      </div>
      <div
        className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={pct ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${name} sync progress`}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300 ease-out",
            done ? "bg-emerald-500" : failed ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}
