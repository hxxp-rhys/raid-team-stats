"use client";

import { useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { api } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";

/**
 * The roster ranks an officer can assign — Raid Leader / Officer / Main / Trial
 * / Flex / Rotational / Social (leadership first). Distinct from the site
 * permission tier (role). New members default to Main; "Unranked" (null) is now
 * a legacy display-only state that can no longer be assigned from the picker.
 */
const RANKS = [
  { value: "RAID_LEADER", label: "Raid Leader" },
  { value: "OFFICER", label: "Officer" },
  { value: "MAIN", label: "Main" },
  { value: "TRIAL", label: "Trial" },
  { value: "FLEX", label: "Flex" },
  { value: "ROTATIONAL", label: "Rotational" },
  { value: "SOCIAL", label: "Social" },
] as const;
type RankValue = (typeof RANKS)[number]["value"];

const DEFAULT_RANK: RankValue = "MAIN";

type EligibleCharacter = { id: string; name: string; realmSlug: string };

/**
 * Searchable combobox for picking an eligible character to add. The native
 * <select> can't host a search box and the repo has no combobox primitive, so
 * this is a lightweight one: a text input that filters the options by name OR
 * realm. The list opens UPWARD because the add bar is pinned to the bottom of
 * the modal.
 */
function EligibleCombobox({
  options,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  options: EligibleCharacter[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const listboxId = useId();
  const selected = options.find((o) => o.id === value);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return options;
    return options.filter(
      (o) =>
        o.name.toLowerCase().includes(s) ||
        o.realmSlug.toLowerCase().includes(s),
    );
  }, [options, q]);

  return (
    <div className="relative min-w-0 flex-1">
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label="Search and select a character to add"
        value={
          open ? q : selected ? `${selected.name} (${selected.realmSlug})` : ""
        }
        onFocus={() => {
          setOpen(true);
          setQ("");
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        // Delay close so an option's onMouseDown can fire first.
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        placeholder={placeholder}
        disabled={disabled}
        className="bg-background border-border h-8 w-full rounded-md border px-2 text-sm disabled:opacity-60"
      />
      {open && !disabled && (
        <ul
          role="listbox"
          id={listboxId}
          className="border-border bg-card absolute bottom-full left-0 z-20 mb-1 max-h-48 w-full overflow-y-auto rounded-md border shadow-lg"
        >
          {filtered.length === 0 ? (
            <li className="text-muted-foreground px-2 py-1.5 text-xs">
              No matches
            </li>
          ) : (
            filtered.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  // onMouseDown (not onClick) so the selection commits before
                  // the input's onBlur closes the list.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange(o.id);
                    setQ("");
                    setOpen(false);
                  }}
                  className={cn(
                    "hover:bg-muted flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm",
                    o.id === value && "bg-muted",
                  )}
                >
                  <span className="truncate">{o.name}</span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {o.realmSlug}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Manage Members modal. Lists the active roster + a picker form for adding
 * new characters from the guild's eligible pool. Mirrors the existing
 * ManageMembers card on the legacy team page; lives in a modal here so the
 * Control Panel keeps the center canvas for widgets.
 */
export function MembersModal({
  open,
  onClose,
  teamId,
}: {
  open: boolean;
  onClose: () => void;
  teamId: string;
}) {
  const utils = api.useUtils();
  const team = api.raidTeam.get.useQuery({ raidTeamId: teamId });
  const eligible = api.raidTeam.eligibleCharacters.useQuery({
    raidTeamId: teamId,
  });
  const [pick, setPick] = useState<string>("");
  const [pickRank, setPickRank] = useState<RankValue>(DEFAULT_RANK);
  const [pickRole, setPickRole] = useState<"MEMBER" | "CO_LEADER">("MEMBER");

  // Active roster in alphabetical order (case-insensitive, locale-aware) — the
  // API doesn't guarantee any ordering. Tie-break by realm so same-name alts on
  // different realms have a stable, deterministic order.
  const sortedMemberships = useMemo(() => {
    const all = team.data?.memberships ?? [];
    return [...all].sort((a, b) => {
      const byName = a.character.name.localeCompare(
        b.character.name,
        undefined,
        { sensitivity: "base" },
      );
      if (byName !== 0) return byName;
      return a.character.realmSlug.localeCompare(b.character.realmSlug);
    });
  }, [team.data?.memberships]);

  const totalCount = team.data?.memberships.length ?? 0;

  const invalidate = async () => {
    await Promise.all([
      utils.raidTeam.get.invalidate({ raidTeamId: teamId }),
      utils.raidTeam.eligibleCharacters.invalidate({ raidTeamId: teamId }),
      utils.snapshot.latestForTeam.invalidate({ raidTeamId: teamId }),
    ]);
  };

  const add = api.raidTeam.addMember.useMutation({
    onSuccess: async () => {
      setPick("");
      setPickRank(DEFAULT_RANK);
      setPickRole("MEMBER");
      await invalidate();
    },
  });
  const remove = api.raidTeam.removeMember.useMutation({
    onSuccess: invalidate,
  });
  const setRank = api.raidTeam.setMemberRank.useMutation({
    onSuccess: invalidate,
  });

  const canManage = !eligible.error;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Manage members"
      description={
        canManage
          ? "Add or remove characters tracked by this raid team."
          : "Active roster. Co-leaders and above can add or remove members."
      }
    >
      <div className="space-y-4 text-sm">
        {team.isPending ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : totalCount === 0 ? (
          <p className="text-muted-foreground">No members yet.</p>
        ) : (
          <ul className="divide-border divide-y">
            {sortedMemberships.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <div className="min-w-0">
                  <span className="font-medium">{m.character.name}</span>
                  <span className="text-muted-foreground ml-2">
                    {m.character.realmSlug} · lvl {m.character.level ?? "—"} ·{" "}
                    {m.role.toLowerCase()}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {canManage ? (
                    <select
                      value={m.rank ?? ""}
                      onChange={(e) =>
                        setRank.mutate({
                          raidTeamId: teamId,
                          characterId: m.character.id,
                          rank: (e.target.value || null) as RankValue | null,
                        })
                      }
                      disabled={setRank.isPending}
                      aria-label={`Rank for ${m.character.name}`}
                      className="bg-background border-border h-8 rounded-md border px-2 text-xs"
                    >
                      {/* "Unranked" is no longer assignable — kept as a disabled
                          placeholder so legacy null-rank members still render. */}
                      <option value="" disabled>
                        — set rank —
                      </option>
                      {RANKS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    m.rank && (
                      <span className="text-muted-foreground text-xs">
                        {RANKS.find((r) => r.value === m.rank)?.label}
                      </span>
                    )
                  )}
                  {canManage && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() =>
                        remove.mutate({
                          raidTeamId: teamId,
                          characterId: m.character.id,
                        })
                      }
                      disabled={remove.isPending}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          // Pinned add bar (character search / rank / role / Add): kept static
          // and flush against the modal's Close footer while the roster scrolls.
          // Spans the body padding (-mx-5 / -mb-4) and sits on the scroll
          // container's bottom edge via `sticky bottom-0`.
          <div className="border-border bg-card sticky bottom-0 -mx-5 -mb-4 border-t">
            <form
              className="flex flex-wrap items-center gap-2 px-5 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!pick) return;
                add.mutate({
                  raidTeamId: teamId,
                  characterId: pick,
                  rank: pickRank,
                  role: pickRole,
                });
              }}
            >
              <EligibleCombobox
                options={eligible.data ?? []}
                value={pick}
                onChange={setPick}
                disabled={
                  eligible.isPending || (eligible.data?.length ?? 0) === 0
                }
                placeholder={
                  eligible.isPending
                    ? "Loading…"
                    : (eligible.data?.length ?? 0) === 0
                      ? "No eligible characters"
                      : "Search a character…"
                }
              />
              <select
                value={pickRank}
                onChange={(e) => setPickRank(e.target.value as RankValue)}
                aria-label="Rank for new member"
                className="bg-background border-border h-8 rounded-md border px-2 text-sm"
              >
                {RANKS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              <select
                value={pickRole}
                onChange={(e) =>
                  setPickRole(e.target.value as "MEMBER" | "CO_LEADER")
                }
                aria-label="Role for new member"
                className="bg-background border-border h-8 rounded-md border px-2 text-sm"
              >
                <option value="MEMBER">Member</option>
                <option value="CO_LEADER">Co-leader</option>
              </select>
              <Button type="submit" disabled={!pick || add.isPending} size="sm">
                {add.isPending ? "Adding…" : "Add"}
              </Button>
            </form>
            {add.error && (
              <p className="text-destructive px-5 pb-2 text-xs" role="alert">
                {add.error.message}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
