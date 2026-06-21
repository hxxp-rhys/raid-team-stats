"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/trpc-client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DiscordSettings } from "./discord-settings";
import {
  DEFAULT_NUDGE_BODY,
  DEFAULT_NUDGE_SUBJECT,
  NUDGE_PLACEHOLDERS,
  NUDGE_SAMPLE_VARS,
  renderNudgeTemplate,
} from "@/lib/calendar/email-template";
import { NUDGE_BODY_MAX, NUDGE_SUBJECT_MAX } from "@/lib/calendar/reminder-policy";

type ReminderCfg = {
  enabled: boolean;
  leadMinutes: number[];
  nudgeMinutes: number[];
  nudgeTemplate?: { subject?: string; body?: string };
};
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
// Quick-add presets for non-responder nudges, ascending (1h→3d); leaders can
// also add custom times in minutes/hours/days.
const NUDGE_PRESETS = [60, 120, 360, 720, 1440, 4320];
const NUDGE_MIN = 5;
const NUDGE_MAX = 10080; // = MAX_LEAD_MINUTES (1 week)
const NUDGE_CAP = 6; // matches reminderConfigSchema .max(6)

/** minutes → compact label, e.g. 1440→"24h", 90→"90m", 2880→"2d". */
function fmtMinutes(m: number): string {
  if (m % 1440 === 0) return `${m / 1440}d`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

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
  // Capture the seeded values once so we can detect unsaved edits in THIS (main)
  // form — used to stop the independent Discord sub-form's Save from closing the
  // modal and silently discarding them.
  const [seed] = useState(() => ({
    tz: current?.timezone ?? "UTC",
    tanks: current?.comp.tanks ?? 2,
    healers: current?.comp.healers ?? 5,
    dps: current?.comp.dps ?? 13,
    remEnabled: current?.reminders.enabled ?? true,
    leads: current?.reminders.leadMinutes ?? [1440, 60],
    nudges: current?.reminders.nudgeMinutes ?? [720],
    emailSubject: current?.reminders.nudgeTemplate?.subject ?? "",
    emailBody: current?.reminders.nudgeTemplate?.body ?? "",
  }));
  const [tz, setTz] = useState(seed.tz);
  const [tanks, setTanks] = useState(seed.tanks);
  const [healers, setHealers] = useState(seed.healers);
  const [dps, setDps] = useState(seed.dps);
  const [remEnabled, setRemEnabled] = useState(seed.remEnabled);
  const [leads, setLeads] = useState<number[]>(seed.leads);
  const [nudges, setNudges] = useState<number[]>(seed.nudges);
  const [addVal, setAddVal] = useState("");
  const [addUnit, setAddUnit] = useState<"m" | "h" | "d">("h");
  const [addErr, setAddErr] = useState("");
  // Custom nudge email. The committed values drive the preview + the save; the
  // editor lightbox works on a draft so Cancel discards cleanly.
  const [emailSubject, setEmailSubject] = useState(seed.emailSubject);
  const [emailBody, setEmailBody] = useState(seed.emailBody);
  const [emailOpen, setEmailOpen] = useState(false);
  const [draftSubject, setDraftSubject] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [focused, setFocused] = useState<"subject" | "body">("body");
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const openEmailEditor = () => {
    setDraftSubject(emailSubject);
    setDraftBody(emailBody);
    setFocused("body");
    setEmailOpen(true);
  };
  // Insert {{ key }} at the caret of whichever field was last focused.
  const insertPlaceholder = (key: string) => {
    const token = `{{ ${key} }}`;
    const el = focused === "subject" ? subjectRef.current : bodyRef.current;
    const cur = focused === "subject" ? draftSubject : draftBody;
    const set = focused === "subject" ? setDraftSubject : setDraftBody;
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? start;
    set(cur.slice(0, start) + token + cur.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + token.length;
      el?.setSelectionRange(pos, pos);
    });
  };

  // While the email lightbox is open, intercept Escape in the CAPTURE phase so
  // it closes ONLY the lightbox. The shared settings Modal's own document-level
  // Escape listener would otherwise also fire and close the settings modal,
  // discarding unsaved edits.
  useEffect(() => {
    if (!emailOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setEmailOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [emailOpen]);

  const toggleLead = (min: number) =>
    setLeads((cur) =>
      cur.includes(min) ? cur.filter((m) => m !== min) : [...cur, min],
    );

  const addNudge = (min: number) =>
    setNudges((cur) =>
      cur.includes(min) || cur.length >= NUDGE_CAP
        ? cur
        : [...cur, min].sort((a, b) => b - a),
    );
  const removeNudge = (min: number) =>
    setNudges((cur) => cur.filter((m) => m !== min));
  const addCustomNudge = () => {
    const n = Number(addVal);
    if (!Number.isFinite(n) || n <= 0) {
      setAddErr("Enter a number.");
      return;
    }
    const mult = addUnit === "d" ? 1440 : addUnit === "h" ? 60 : 1;
    const min = Math.round(n * mult);
    if (min < NUDGE_MIN || min > NUDGE_MAX) {
      setAddErr(`Pick a time between ${NUDGE_MIN}m and ${NUDGE_MAX / 1440}d before start.`);
      return;
    }
    addNudge(min);
    setAddVal("");
    setAddErr("");
  };

  // True when any main-form field differs from its seeded value. The Discord
  // sub-form uses this to avoid closing the modal (and discarding these edits).
  const mainDirty =
    tz !== seed.tz ||
    tanks !== seed.tanks ||
    healers !== seed.healers ||
    dps !== seed.dps ||
    remEnabled !== seed.remEnabled ||
    leads.join(",") !== seed.leads.join(",") ||
    nudges.join(",") !== seed.nudges.join(",") ||
    emailSubject !== seed.emailSubject ||
    emailBody !== seed.emailBody;

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
    <div className="space-y-4">
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
                nudgeMinutes: nudges,
                nudgeTemplate:
                  emailSubject.trim() || emailBody.trim()
                    ? {
                        subject: emailSubject.trim() || undefined,
                        body: emailBody.trim() || undefined,
                      }
                    : undefined,
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
                  <Label className="text-xs">Nudge non-responders</Label>
                  {/* Quick presets + custom add. */}
                  <div className="flex flex-wrap items-center gap-1 pt-0.5">
                    {NUDGE_PRESETS.filter((m) => !nudges.includes(m)).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => addNudge(m)}
                        disabled={nudges.length >= NUDGE_CAP}
                        className="border-border text-muted-foreground hover:bg-muted rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40"
                      >
                        + {fmtMinutes(m)}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={1}
                      value={addVal}
                      onChange={(e) => {
                        setAddVal(e.target.value);
                        if (addErr) setAddErr("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addCustomNudge();
                        }
                      }}
                      placeholder="custom"
                      className="h-8 w-20"
                      disabled={nudges.length >= NUDGE_CAP}
                    />
                    <select
                      value={addUnit}
                      onChange={(e) => setAddUnit(e.target.value as "m" | "h" | "d")}
                      disabled={nudges.length >= NUDGE_CAP}
                      className="border-border bg-background h-8 rounded-md border px-2 text-xs"
                    >
                      <option value="d">days</option>
                      <option value="h">hours</option>
                      <option value="m">minutes</option>
                    </select>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={addCustomNudge}
                      disabled={nudges.length >= NUDGE_CAP || addVal.trim() === ""}
                    >
                      Add
                    </Button>
                    <span className="text-muted-foreground text-xs">before start</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="ml-auto"
                      onClick={openEmailEditor}
                    >
                      Customize email
                    </Button>
                  </div>
                  {addErr && (
                    <p className="text-destructive text-xs" role="alert">
                      {addErr}
                    </p>
                  )}
                  <p className="text-muted-foreground text-xs">
                    One “please sign up” email to non-responders at each time
                    (up to {NUDGE_CAP}). Between {NUDGE_MIN}m and{" "}
                    {NUDGE_MAX / 1440} days before start.
                  </p>
                  {/* Active nudges — removable chips (incl. custom times). */}
                  <div className="space-y-1 pt-1">
                    <Label className="text-xs">Scheduled nudges</Label>
                    {nudges.length === 0 ? (
                      <p className="text-muted-foreground text-xs italic">
                        No nudges set.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {nudges.map((m) => (
                        <span
                          key={m}
                          className="border-primary bg-primary/10 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium"
                        >
                          {fmtMinutes(m)} before
                          <button
                            type="button"
                            onClick={() => removeNudge(m)}
                            aria-label={`Remove ${fmtMinutes(m)} nudge`}
                            className="text-muted-foreground hover:text-destructive -mr-0.5 ml-0.5 leading-none"
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                      </div>
                    )}
                    {/* Preview of the nudge email (default or custom) rendered
                        with sample data, so the leader sees what raiders get. */}
                    <div className="space-y-1 pt-1.5">
                      <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
                        Email preview (
                        {emailSubject.trim() || emailBody.trim() ? "custom" : "default"})
                      </p>
                      <div className="border-border bg-muted/30 space-y-1 rounded-md border p-2 text-xs">
                        <p className="font-medium">
                          {renderNudgeTemplate(
                            emailSubject.trim() || DEFAULT_NUDGE_SUBJECT,
                            NUDGE_SAMPLE_VARS,
                          )}
                        </p>
                        <hr className="border-border/60" />
                        <p className="text-muted-foreground whitespace-pre-wrap">
                          {renderNudgeTemplate(
                            emailBody.trim() || DEFAULT_NUDGE_BODY,
                            NUDGE_SAMPLE_VARS,
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
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

    {/* Discord binding lives OUTSIDE the form (own mutations) so pressing Enter
        in a Discord ID field can't submit the calendar settings form. Hidden
        entirely when the bot isn't configured. Its Save closes the modal on a
        successful update (onSaved). */}
    <DiscordSettings
      raidTeamId={raidTeamId}
      canLead
      onSaved={onClose}
      mainHasUnsavedEdits={mainDirty}
    />

    {/* Email-customize lightbox. A self-contained overlay (not the shared Modal)
        so its backdrop/escape can't also dismiss the settings modal underneath
        and discard unsaved edits. Subject on top, body below, placeholder chips. */}
    {emailOpen && (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Customize nudge email"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setEmailOpen(false);
        }}
      >
        <div className="border-border bg-card max-h-[85vh] w-full max-w-xl space-y-3 overflow-y-auto rounded-lg border p-5 text-sm shadow-2xl">
          <div>
            <h2 className="text-base font-semibold">Customize nudge email</h2>
            <p className="text-muted-foreground text-xs">
              Sent to non-responders. Insert placeholders for per-recipient
              details; leave both fields blank to use the default.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground mr-1 text-xs">Insert:</span>
            {NUDGE_PLACEHOLDERS.map((p) => (
              <button
                key={p.key}
                type="button"
                title={p.label}
                onClick={() => insertPlaceholder(p.key)}
                className="border-border text-muted-foreground hover:bg-muted rounded-md border px-1.5 py-0.5 font-mono text-[11px]"
              >
                {`{{ ${p.key} }}`}
              </button>
            ))}
          </div>
          <div className="space-y-1">
            <Label htmlFor="nudge-subject" className="text-xs">
              Subject
            </Label>
            <input
              id="nudge-subject"
              ref={subjectRef}
              type="text"
              value={draftSubject}
              maxLength={NUDGE_SUBJECT_MAX}
              placeholder={DEFAULT_NUDGE_SUBJECT}
              onFocus={() => setFocused("subject")}
              onChange={(e) => setDraftSubject(e.target.value)}
              className="border-border bg-background h-8 w-full rounded-md border px-2 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="nudge-body" className="text-xs">
              Body
            </Label>
            <textarea
              id="nudge-body"
              ref={bodyRef}
              value={draftBody}
              maxLength={NUDGE_BODY_MAX}
              rows={9}
              placeholder={DEFAULT_NUDGE_BODY}
              onFocus={() => setFocused("body")}
              onChange={(e) => setDraftBody(e.target.value)}
              className="border-border bg-background w-full rounded-md border px-2 py-1.5 font-mono text-xs"
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Unknown placeholders render as blank. Times are shown in the team
            timezone.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setEmailOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                setEmailSubject(draftSubject);
                setEmailBody(draftBody);
                setEmailOpen(false);
              }}
            >
              Done
            </Button>
          </div>
        </div>
      </div>
    )}
    </div>
  );
}
