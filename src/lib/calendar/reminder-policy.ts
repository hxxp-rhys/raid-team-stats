/**
 * Pure policy for auto-reminders: parse a team's reminder config and decide
 * which reminder "kinds" are DUE for one event at a given instant.
 *
 * A reminder kind fires exactly once per recipient (the server claims a
 * SentReminder row before sending). This module only answers "is kind K within
 * its firing window right now?" — the window is [start - lead, start - lead +
 * grace): it opens at the lead time and closes after a short grace so that a
 * reminder missed during worker downtime fires late rather than never, but a
 * long outage doesn't fire a "24h before" mail 1h before the raid.
 */

export type ReminderConfig = {
  enabled: boolean;
  /** Minutes-before-start to remind people who are GOING. */
  leadMinutes: number[];
  /** Minutes-before to nudge non-responders. Empty = no nudges. */
  nudgeMinutes: number[];
  /**
   * Optional custom nudge email. Omitted (or empty fields) = use the built-in
   * default copy (see src/lib/calendar/email-template.ts). Subject/body may
   * contain {{ placeholder }} tokens resolved at send time.
   */
  nudgeTemplate?: { subject?: string; body?: string };
};

/** Caps for the custom nudge email (also enforced server-side in zod). */
export const NUDGE_SUBJECT_MAX = 200;
export const NUDGE_BODY_MAX = 4000;

export const DEFAULT_REMINDER_CONFIG: ReminderConfig = {
  enabled: true,
  leadMinutes: [1440, 60], // 24h + 1h
  nudgeMinutes: [720], // 12h
};

/** How long after a lead threshold passes we'll still send it (downtime slack). */
export const REMINDER_GRACE_MIN = 90;

/**
 * Largest lead/nudge a team may configure (1 week). The reminder sweep's
 * candidate-query horizon (REMINDER_LOOKAHEAD_MINUTES) is derived from this, so
 * the schema bound and the sweep window can never drift apart — a configurable
 * lead the sweep can't reach (its firing window would close before the event
 * enters the query) is impossible by construction.
 */
export const MAX_LEAD_MINUTES = 7 * 24 * 60; // 10080

/**
 * How far ahead the reminder sweep must look: the longest configurable lead
 * plus the grace window, so the firing window of even a max-lead reminder is
 * still open while the event is inside the candidate query.
 */
export const REMINDER_LOOKAHEAD_MINUTES = MAX_LEAD_MINUTES + REMINDER_GRACE_MIN;

/** Largest lead the sweep must look ahead by (minutes). Used to bound the query. */
export function maxLookaheadMinutes(cfg: ReminderConfig): number {
  const leads = [...cfg.leadMinutes, ...cfg.nudgeMinutes];
  return Math.max(0, ...leads) + REMINDER_GRACE_MIN;
}

/** Dedupe, drop non-positive, round, and sort minutes descending. */
function normalizeMinutes(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0)
        .map((n) => Math.round(n)),
    ),
  ).sort((a, b) => b - a);
}

/** Coerce arbitrary JSON (or null) into a valid config, applying defaults. */
export function parseReminderConfig(raw: unknown): ReminderConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_REMINDER_CONFIG;
  const r = raw as Record<string, unknown>;
  const enabled = typeof r.enabled === "boolean" ? r.enabled : true;
  const leadMinutes = Array.isArray(r.leadMinutes)
    ? normalizeMinutes(r.leadMinutes)
    : DEFAULT_REMINDER_CONFIG.leadMinutes;
  // nudgeMinutes is now a LIST (multiple nudges). An explicit array — including
  // an empty one — is honored verbatim (a leader turning all nudges off). A
  // legacy scalar `number|null` (pre-multi-nudge) is coerced; an absent key
  // falls back to the default, matching leadMinutes' missing-key behavior.
  const nudgeMinutes = Array.isArray(r.nudgeMinutes)
    ? normalizeMinutes(r.nudgeMinutes)
    : r.nudgeMinutes === undefined
      ? DEFAULT_REMINDER_CONFIG.nudgeMinutes
      : typeof r.nudgeMinutes === "number" && Number.isFinite(r.nudgeMinutes) && r.nudgeMinutes > 0
        ? [Math.round(r.nudgeMinutes)]
        : []; // null or garbage → no nudges
  // PRESERVE the custom nudge email across normalization (this function is the
  // round-trip on every settings save; an un-preserved key would silently
  // vanish). Trim + length-cap; drop entirely if both fields are empty.
  const nudgeTemplate = parseNudgeTemplate(r.nudgeTemplate);
  return nudgeTemplate
    ? { enabled, leadMinutes, nudgeMinutes, nudgeTemplate }
    : { enabled, leadMinutes, nudgeMinutes };
}

/** Coerce a stored/user template into a clean {subject?,body?} or undefined. */
function parseNudgeTemplate(
  raw: unknown,
): { subject?: string; body?: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  const subject =
    typeof t.subject === "string" ? t.subject.trim().slice(0, NUDGE_SUBJECT_MAX) : "";
  const body = typeof t.body === "string" ? t.body.trim().slice(0, NUDGE_BODY_MAX) : "";
  const out: { subject?: string; body?: string } = {};
  if (subject) out.subject = subject;
  if (body) out.body = body;
  return out.subject || out.body ? out : undefined;
}

export type DueReminder =
  | { kind: `lead:${number}`; audience: "going"; leadMinutes: number }
  | { kind: `nudge:${number}`; audience: "no-response"; leadMinutes: number };

/**
 * Which reminder kinds are due for an event starting at `startMs`, evaluated at
 * `nowMs`. Returns [] for a disabled config or an event already started/past.
 */
export function dueReminders(
  cfg: ReminderConfig,
  startMs: number,
  nowMs: number,
  graceMin: number = REMINDER_GRACE_MIN,
): DueReminder[] {
  if (!cfg.enabled) return [];
  if (nowMs >= startMs) return []; // never remind once it's begun
  const out: DueReminder[] = [];
  const graceMs = graceMin * 60_000;

  const inWindow = (leadMin: number): boolean => {
    const threshold = startMs - leadMin * 60_000; // when this reminder opens
    return nowMs >= threshold && nowMs < threshold + graceMs;
  };

  for (const leadMin of cfg.leadMinutes) {
    if (inWindow(leadMin)) {
      out.push({ kind: `lead:${leadMin}`, audience: "going", leadMinutes: leadMin });
    }
  }
  // Each nudge time fires once per non-responder — distinct `nudge:<min>` kinds
  // so the SentReminder (event, kind, user) ledger keeps them exactly-once each.
  for (const nudgeMin of cfg.nudgeMinutes) {
    if (inWindow(nudgeMin)) {
      out.push({ kind: `nudge:${nudgeMin}`, audience: "no-response", leadMinutes: nudgeMin });
    }
  }
  return out;
}
