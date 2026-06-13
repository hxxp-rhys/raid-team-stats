"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Current = { timezone: string; comp: { tanks: number; healers: number; dps: number } };

// A short curated list + free-type fallback covers the common raiding regions
// without shipping the whole IANA database into the bundle.
const COMMON_TZ = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Australia/Sydney",
];

export function SettingsModal({
  raidTeamId,
  open,
  onClose,
  current,
}: {
  raidTeamId: string;
  open: boolean;
  onClose: () => void;
  current: Current | null;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Calendar settings"
      description="Team home timezone and the comp-readiness target."
    >
      {open && (
        <Body raidTeamId={raidTeamId} onClose={onClose} current={current} />
      )}
    </Modal>
  );
}

/** Mounted only while open; seeded once from `current` via useState initializers. */
function Body({
  raidTeamId,
  onClose,
  current,
}: {
  raidTeamId: string;
  onClose: () => void;
  current: Current | null;
}) {
  const utils = api.useUtils();
  const [tz, setTz] = useState(current?.timezone ?? "UTC");
  const [tanks, setTanks] = useState(current?.comp.tanks ?? 2);
  const [healers, setHealers] = useState(current?.comp.healers ?? 5);
  const [dps, setDps] = useState(current?.comp.dps ?? 13);

  const save = api.calendar.setSettings.useMutation({
    onSuccess: async () => {
      await utils.calendar.meta.invalidate({ raidTeamId });
      await utils.calendar.eventDetail.invalidate();
      onClose();
    },
  });

  const tzOptions =
    current && !COMMON_TZ.includes(current.timezone)
      ? [current.timezone, ...COMMON_TZ]
      : COMMON_TZ;

  return (
    <form
          className="space-y-4 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({
              raidTeamId,
              timezone: tz,
              comp: { tanks, healers, dps },
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="tz">Home timezone</Label>
            <select
              id="tz"
              value={tz}
              onChange={(e) => setTz(e.target.value)}
              className="border-border bg-background h-9 w-full rounded-md border px-2 text-sm"
            >
              {tzOptions.map((z) => (
                <option key={z} value={z}>{z}</option>
              ))}
            </select>
            <p className="text-muted-foreground text-xs">
              Raid times are entered + stored in this zone (DST-correct);
              everyone sees them in their own local time.
            </p>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Comp target (readiness meter)
            </p>
            <div className="grid grid-cols-3 gap-2">
              {([
                ["Tanks", tanks, setTanks] as const,
                ["Healers", healers, setHealers] as const,
                ["DPS", dps, setDps] as const,
              ]).map(([label, val, set]) => (
                <div key={label} className="space-y-1">
                  <Label className="text-xs">{label}</Label>
                  <Input
                    type="number"
                    min={0}
                    max={40}
                    value={val}
                    onChange={(e) => set(Math.max(0, Math.min(40, Number(e.target.value) || 0)))}
                  />
                </div>
              ))}
            </div>
          </div>

          {save.error && (
            <p className="text-destructive text-xs" role="alert">{save.error.message}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
    </form>
  );
}
