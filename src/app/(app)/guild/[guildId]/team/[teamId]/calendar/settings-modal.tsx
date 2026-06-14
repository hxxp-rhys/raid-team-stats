"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DiscordSettings } from "./discord-settings";

type ReminderCfg = { enabled: boolean; leadMinutes: number[]; nudgeMinutes: number | null };
type Current = {
  timezone: string;
  comp: { tanks: number; healers: number; dps: number };
  reminders: ReminderCfg;
};

const LEAD_PRESETS = [
  { min: 10080, label: "1 week" },
  { min: 1440, label: "24h" },
  { min: 720, label: "12h" },
  { min: 120, label: "2h" },
  { min: 60, label: "1h" },
  { min: 30, label: "30m" },
];
const NUDGE_PRESETS: { min: number | null; label: string }[] = [
  { min: null, label: "Off" },
  { min: 1440, label: "24h before" },
  { min: 720, label: "12h before" },
  { min: 360, label: "6h before" },
  { min: 120, label: "2h before" },
];

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
      description="Timezone, comp-readiness target, and auto-reminders."
      hideDefaultFooter
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
  const [remEnabled, setRemEnabled] = useState(current?.reminders.enabled ?? true);
  const [leads, setLeads] = useState<number[]>(current?.reminders.leadMinutes ?? [1440, 60]);
  const [nudge, setNudge] = useState<number | null>(
    current?.reminders.nudgeMinutes ?? 720,
  );

  const toggleLead = (min: number) =>
    setLeads((cur) =>
      cur.includes(min) ? cur.filter((m) => m !== min) : [...cur, min],
    );

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
              reminders: {
                enabled: remEnabled,
                leadMinutes: leads,
                nudgeMinutes: nudge,
              },
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

          <div className="border-border border-t pt-3">
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <input
                type="checkbox"
                checked={remEnabled}
                onChange={(e) => setRemEnabled(e.target.checked)}
                className="accent-primary h-4 w-4"
              />
              Auto-reminders (email)
            </label>
            {remEnabled && (
              <div className="mt-2 space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Remind people who are going</Label>
                  <div className="flex flex-wrap gap-1">
                    {LEAD_PRESETS.map((p) => {
                      const on = leads.includes(p.min);
                      return (
                        <button
                          key={p.min}
                          type="button"
                          onClick={() => toggleLead(p.min)}
                          aria-pressed={on}
                          className={
                            "rounded-md border px-2 py-1 text-xs font-medium transition-colors " +
                            (on
                              ? "border-primary bg-primary/10 text-foreground"
                              : "border-border text-muted-foreground hover:bg-muted")
                          }
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Sent before start to anyone Confirmed / Tentative / Late.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rem-nudge" className="text-xs">
                    Nudge non-responders
                  </Label>
                  <select
                    id="rem-nudge"
                    value={nudge === null ? "" : String(nudge)}
                    onChange={(e) => setNudge(e.target.value === "" ? null : Number(e.target.value))}
                    className="border-border bg-background h-9 w-full rounded-md border px-2 text-sm"
                  >
                    {NUDGE_PRESETS.map((p) => (
                      <option key={p.label} value={p.min === null ? "" : String(p.min)}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-muted-foreground text-xs">
                    One “please sign up” email to members with no response.
                  </p>
                </div>
              </div>
            )}
          </div>

          {save.error && (
            <p className="text-destructive text-xs" role="alert">{save.error.message}</p>
          )}

          {/* Discord binding (own mutations; hidden when the bot isn't configured) */}
          <DiscordSettings raidTeamId={raidTeamId} canLead />

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
