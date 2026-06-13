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
  /** Minutes-before to nudge non-responders, or null = no nudge. */
  nudgeMinutes: number | null;
};

export const DEFAULT_REMINDER_CONFIG: ReminderConfig = {
  enabled: true,
  leadMinutes: [1440, 60], // 24h + 1h
  nudgeMinutes: 720, // 12h
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
  const leads = [...cfg.leadMinutes, cfg.nudgeMinutes ?? 0];
  return Math.max(0, ...leads) + REMINDER_GRACE_MIN;
}

/** Coerce arbitrary JSON (or null) into a valid config, applying defaults. */
export function parseReminderConfig(raw: unknown): ReminderConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_REMINDER_CONFIG;
  const r = raw as Record<string, unknown>;
  const enabled = typeof r.enabled === "boolean" ? r.enabled : true;
  const leadMinutes = Array.isArray(r.leadMinutes)
    ? Array.from(
        new Set(
          r.leadMinutes
            .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0)
            .map((n) => Math.round(n)),
        ),
      ).sort((a, b) => b - a)
    : DEFAULT_REMINDER_CONFIG.leadMinutes;
  const nudgeMinutes =
    r.nudgeMinutes === null
      ? null
      : typeof r.nudgeMinutes === "number" && Number.isFinite(r.nudgeMinutes) && r.nudgeMinutes > 0
        ? Math.round(r.nudgeMinutes)
        : DEFAULT_REMINDER_CONFIG.nudgeMinutes;
  return { enabled, leadMinutes, nudgeMinutes };
}

export type DueReminder =
  | { kind: `lead:${number}`; audience: "going"; leadMinutes: number }
  | { kind: "nudge"; audience: "no-response"; leadMinutes: number };

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
  if (cfg.nudgeMinutes != null && inWindow(cfg.nudgeMinutes)) {
    out.push({ kind: "nudge", audience: "no-response", leadMinutes: cfg.nudgeMinutes });
  }
  return out;
}
