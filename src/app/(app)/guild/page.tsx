"use client";

import Link from "next/link";
import { useState } from "react";
import type { Route } from "next";

import { Button } from "@/components/ui/button";
import { AddGuildModal } from "@/components/guild/add-guild-modal";
import { api } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: "text-green-500",
  PENDING: "text-amber-500",
  DEPARTED: "text-muted-foreground",
};

/**
 * Guild list, accordion-style. Clicking a guild highlights it and expands an
 * inline Teams section directly below the row. Selecting a team from the
 * expansion routes to that team's Dashboard Control Panel.
 *
 * Only one guild can be expanded at a time — clicking another guild collapses
 * the previous expansion. The selected-guild id is component-local state
 * (lost on navigation); deep-linking is out of scope for now.
 */
export default function GuildIndexPage() {
  const guilds = api.guild.myGuilds.useQuery();
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your guilds</h1>
          <p className="text-muted-foreground text-sm">
            Click a guild to see its raid teams. Click a team to open its
            dashboard control panel.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => setShowAdd(true)}
          className="shrink-0"
        >
          Add Guild
        </Button>
      </header>

      {showAdd && <AddGuildModal onClose={() => setShowAdd(false)} />}

      {guilds.isPending ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : guilds.error ? (
        <p className="text-destructive text-sm" role="alert">
          {guilds.error.message}
        </p>
      ) : guilds.data && guilds.data.length === 0 ? (
        <div className="border-border rounded-lg border bg-card p-6 text-sm">
          <p className="font-medium">No guilds yet.</p>
          <p className="text-muted-foreground mt-1">
            Make sure Battle.net is linked on your{" "}
            <Link
              href={"/account" as Route}
              className="text-primary underline-offset-4 hover:underline"
            >
              account page
            </Link>
            , then click <strong>Add Guild</strong> above to find and add your
            guilds.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {guilds.data?.map((m) => {
            const isSelected = m.guildId === selectedGuildId;
            return (
              <li key={m.id}>
                <GuildRow
                  guildId={m.guildId}
                  name={m.guild.name}
                  region={m.guild.region}
                  realmSlug={m.guild.realmSlug}
                  faction={m.guild.faction}
                  role={m.role}
                  status={m.status}
                  isAdmin={m.isAdmin}
                  isSelected={isSelected}
                  onSelect={() =>
                    setSelectedGuildId((id) =>
                      id === m.guildId ? null : m.guildId,
                    )
                  }
                />
                {isSelected && <TeamsPanel guildId={m.guildId} />}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

function GuildRow({
  guildId,
  name,
  region,
  realmSlug,
  faction,
  role,
  status,
  isAdmin,
  isSelected,
  onSelect,
}: {
  guildId: string;
  name: string;
  region: string;
  realmSlug: string;
  faction: string;
  role: string;
  status: string;
  isAdmin: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <div className="flex items-stretch gap-2">
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={isSelected}
        aria-controls={`teams-${guildId}`}
        className={cn(
          "flex-1 rounded-lg border bg-card p-4 text-left transition-colors",
          isSelected
            ? "border-primary ring-primary ring-2"
            : "border-border hover:border-primary/50",
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-medium">{name}</h2>
            <p className="text-muted-foreground text-xs">
              {region} · {realmSlug} · {faction}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm font-medium">{role}</p>
            <p
              className={`text-xs ${
                STATUS_BADGE[status] ?? "text-muted-foreground"
              }`}
            >
              {status}
            </p>
          </div>
          <span
            aria-hidden
            className={cn(
              "text-muted-foreground ml-2 inline-block transition-transform",
              isSelected && "rotate-90",
            )}
          >
            ›
          </span>
        </div>
      </button>
      {(isAdmin || role === "OWNER" || role === "OFFICER") && (
        <Link
          href={`/guild/${guildId}` as Route}
          title="Guild settings"
          className="border-border bg-background text-muted-foreground hover:text-foreground hover:border-primary/50 inline-flex w-10 items-center justify-center rounded-lg border text-sm transition-colors"
        >
          ⚙
        </Link>
      )}
    </div>
  );
}

/**
 * Inline teams panel rendered under a selected guild row. Lists the visible
 * raid teams + a Create form for staff. Clicking a team routes to that
 * team's dashboard control panel (= the team detail page).
 */
function TeamsPanel({ guildId }: { guildId: string }) {
  const detail = api.guild.get.useQuery({ guildId });

  if (detail.isPending) {
    return (
      <div
        id={`teams-${guildId}`}
        className="border-border bg-muted/30 ml-2 mt-2 rounded-md border-l-2 px-4 py-3 text-sm"
      >
        Loading teams…
      </div>
    );
  }
  if (detail.error) {
    return (
      <div
        id={`teams-${guildId}`}
        className="border-destructive bg-destructive/10 text-destructive ml-2 mt-2 rounded-md border-l-2 px-4 py-3 text-sm"
        role="alert"
      >
        {detail.error.message}
      </div>
    );
  }
  const { guild, myRole, isAdmin } = detail.data!;
  const isStaff =
    myRole === "OWNER" || myRole === "OFFICER" || isAdmin === true;

  return (
    <div
      id={`teams-${guildId}`}
      className="border-primary/40 bg-muted/30 ml-2 mt-2 space-y-3 rounded-md border-l-2 px-4 py-3"
    >
      <h3 className="text-foreground text-sm font-semibold uppercase tracking-wide">
        Teams
      </h3>

      {guild.raidTeams.length === 0 ? (
        <p className="text-muted-foreground text-sm">No teams yet.</p>
      ) : (
        <ul className="space-y-1">
          {guild.raidTeams.map((t) => (
            <li key={t.id}>
              <Link
                href={`/guild/${guildId}/team/${t.id}` as Route}
                className="border-border bg-card hover:border-primary block rounded-md border px-3 py-2 text-sm transition-colors"
              >
                <p className="font-medium">{t.name}</p>
                <p className="text-muted-foreground text-xs">
                  {t._count.memberships} member
                  {t._count.memberships === 1 ? "" : "s"} · visibility{" "}
                  {t.visibility.toLowerCase()}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {isStaff && (
        <p className="text-muted-foreground text-xs">
          Teams are created from the guild settings page (the ⚙ next to the
          guild).
        </p>
      )}
    </div>
  );
}
