"use client";

import { useState, type ChangeEvent } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/trpc-client";
import type { WidgetInstance } from "@/lib/widgets/types";

/**
 * Inline configuration editor for a single widget instance. The editor is
 * widget-type-specific; widgets with no schema (most of them) return null
 * so the caller can skip rendering the trigger button.
 */
export function WidgetConfigEditor({
  raidTeamId,
  widget,
  onChange,
  onClose,
}: {
  raidTeamId: string;
  widget: WidgetInstance;
  onChange: (config: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  if (widget.type === "character_timeline") {
    return (
      <CharacterTimelineConfig
        raidTeamId={raidTeamId}
        widget={widget}
        onChange={onChange}
        onClose={onClose}
      />
    );
  }
  return null;
}

function CharacterTimelineConfig({
  raidTeamId,
  widget,
  onChange,
  onClose,
}: {
  raidTeamId: string;
  widget: WidgetInstance;
  onChange: (config: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const team = api.snapshot.latestForTeam.useQuery({ raidTeamId });
  const initial =
    typeof widget.config?.characterId === "string"
      ? widget.config.characterId
      : "";
  const [characterId, setCharacterId] = useState<string>(initial);

  const handleSelect = (e: ChangeEvent<HTMLSelectElement>) => {
    setCharacterId(e.target.value);
  };

  const handleSave = () => {
    onChange({ characterId: characterId || undefined });
    onClose();
  };

  return (
    <div className="border-border bg-muted/20 space-y-3 rounded-md border p-3 text-sm">
      <p className="text-muted-foreground text-xs">
        Pick which character&apos;s timeline this widget should show. Defaults
        to the team&apos;s first tracked character.
      </p>
      {team.isPending ? (
        <p className="text-muted-foreground">Loading roster…</p>
      ) : team.error ? (
        <p className="text-destructive">{team.error.message}</p>
      ) : (
        <select
          value={characterId}
          onChange={handleSelect}
          className="border-input bg-background w-full rounded-md border px-2 py-1.5 text-sm"
        >
          <option value="">— Default (first tracked) —</option>
          {team.data.members.map((m) => (
            <option key={m.character.id} value={m.character.id}>
              {m.character.name} ({m.character.realmSlug})
            </option>
          ))}
        </select>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" size="xs" onClick={handleSave}>
          Save
        </Button>
      </div>
    </div>
  );
}
