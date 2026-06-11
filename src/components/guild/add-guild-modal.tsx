"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { api } from "@/lib/trpc-client";

/**
 * "Add Guild" lightbox. Two-step, fully server-derived:
 *   1) On open it runs `guild.discoverGuildCandidates` (observe the caller's
 *      Battle.net characters; ZERO writes) and lists the distinct guilds.
 *   2) The user ticks which to add; "Add selected" calls
 *      `guild.addDiscoveredGuilds` which RE-derives from OAuth and adds only
 *      the ticked guilds (the keys are a filter, never trusted as input).
 *
 * Guilds the user already belongs to render disabled + checked ("Already
 * added"). Nothing is pre-selected otherwise — per spec, a guild the user
 * doesn't tick is not added.
 */
export function AddGuildModal({ onClose }: { onClose: () => void }) {
  const utils = api.useUtils();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<{ added: number } | null>(null);

  const discover = api.guild.discoverGuildCandidates.useMutation();
  const add = api.guild.addDiscoveredGuilds.useMutation({
    onSuccess: async (res) => {
      await utils.guild.myGuilds.invalidate();
      setDone({ added: res.added });
    },
  });

  // Auto-run discovery exactly once on open. The mutation does no writes, so
  // a Strict-Mode double-invoke in dev is at worst a wasted Battle.net read;
  // the ref keeps it to one call anyway.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    discover.mutate();
  }, [discover]);

  const candidates = discover.data?.candidates ?? [];
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
    >
      {done ? (
        <div className="space-y-3 text-sm">
          <p className="text-foreground">
            {done.added === 0
              ? "No new guilds were added."
              : `Added ${done.added} guild${done.added === 1 ? "" : "s"}. They now appear in your guild list.`}
          </p>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : discover.isPending ? (
        <p className="text-muted-foreground text-sm">
          Searching your Battle.net characters…
        </p>
      ) : discover.error ? (
        <div className="space-y-3 text-sm">
          <p className="text-destructive" role="alert">
            {discover.error.message}
          </p>
          <p className="text-muted-foreground">
            You may need to{" "}
            <Link
              href={"/account" as Route}
              className="text-primary underline-offset-4 hover:underline"
            >
              reconnect Battle.net
            </Link>{" "}
            on your account page.
          </p>
        </div>
      ) : candidates.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No guilds found for your Battle.net characters. If you just joined
          one, it can take Blizzard a little while to show it.
        </p>
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
