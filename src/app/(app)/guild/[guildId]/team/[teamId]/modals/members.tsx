"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { api } from "@/lib/trpc-client";

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
  const [pickRole, setPickRole] = useState<"MEMBER" | "CO_LEADER">("MEMBER");

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
      setPickRole("MEMBER");
      await invalidate();
    },
  });
  const remove = api.raidTeam.removeMember.useMutation({
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
        {team.data && team.data.memberships.length === 0 ? (
          <p className="text-muted-foreground">No members yet.</p>
        ) : (
          <ul className="divide-border divide-y">
            {team.data?.memberships.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <div>
                  <span className="font-medium">{m.character.name}</span>
                  <span className="text-muted-foreground ml-2">
                    {m.character.realmSlug} · lvl {m.character.level ?? "—"} ·{" "}
                    {m.role.toLowerCase()}
                  </span>
                </div>
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
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          <form
            className="border-border flex flex-wrap items-center gap-2 border-t pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!pick) return;
              add.mutate({
                raidTeamId: teamId,
                characterId: pick,
                role: pickRole,
              });
            }}
          >
            <select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className="bg-background border-border h-8 flex-1 rounded-md border px-2 text-sm"
              disabled={
                eligible.isPending || (eligible.data?.length ?? 0) === 0
              }
            >
              <option value="">
                {eligible.isPending
                  ? "Loading…"
                  : (eligible.data?.length ?? 0) === 0
                    ? "No eligible characters"
                    : "Select a character"}
              </option>
              {eligible.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.realmSlug})
                </option>
              ))}
            </select>
            <select
              value={pickRole}
              onChange={(e) =>
                setPickRole(e.target.value as "MEMBER" | "CO_LEADER")
              }
              className="bg-background border-border h-8 rounded-md border px-2 text-sm"
            >
              <option value="MEMBER">Member</option>
              <option value="CO_LEADER">Co-leader</option>
            </select>
            <Button type="submit" disabled={!pick || add.isPending} size="sm">
              {add.isPending ? "Adding…" : "Add"}
            </Button>
          </form>
        )}
        {add.error && (
          <p className="text-destructive text-xs" role="alert">
            {add.error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}
