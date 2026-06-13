import { describe, expect, it } from "vitest";

import {
  DEFAULT_REMINDER_CONFIG,
  dueReminders,
  MAX_LEAD_MINUTES,
  maxLookaheadMinutes,
  parseReminderConfig,
  REMINDER_GRACE_MIN,
  REMINDER_LOOKAHEAD_MINUTES,
  type ReminderConfig,
} from "./reminder-policy";

const MIN = 60_000;
const start = 1_000_000_000_000; // arbitrary fixed instant (ms)

const cfg = (over: Partial<ReminderConfig> = {}): ReminderConfig => ({
  enabled: true,
  leadMinutes: [1440, 60],
  nudgeMinutes: 720,
  ...over,
});

describe("parseReminderConfig", () => {
  it("returns defaults for null/garbage", () => {
    expect(parseReminderConfig(null)).toEqual(DEFAULT_REMINDER_CONFIG);
    expect(parseReminderConfig(42)).toEqual(DEFAULT_REMINDER_CONFIG);
  });

  it("sanitizes: dedupes + sorts leads desc, drops non-positive, allows null nudge", () => {
    expect(
      parseReminderConfig({ enabled: false, leadMinutes: [60, 1440, 60, -5, 0, 30.4], nudgeMinutes: null }),
    ).toEqual({ enabled: false, leadMinutes: [1440, 60, 30], nudgeMinutes: null });
  });

  it("falls back nudge to default when invalid, keeps explicit null", () => {
    expect(parseReminderConfig({ nudgeMinutes: -3 }).nudgeMinutes).toBe(720);
    expect(parseReminderConfig({ nudgeMinutes: null }).nudgeMinutes).toBeNull();
  });
});

describe("maxLookaheadMinutes", () => {
  it("is the largest lead/nudge plus grace", () => {
    expect(maxLookaheadMinutes(cfg())).toBe(1440 + REMINDER_GRACE_MIN);
    expect(maxLookaheadMinutes(cfg({ leadMinutes: [30], nudgeMinutes: null }))).toBe(30 + REMINDER_GRACE_MIN);
  });

  it("the sweep lookahead covers the worst-case storable config (no drift)", () => {
    // The reminder sweep's candidate query bounds at REMINDER_LOOKAHEAD_MINUTES.
    // The schema caps any lead/nudge at MAX_LEAD_MINUTES. The firing window of
    // even a max-lead reminder must open while the event is still queryable —
    // i.e. lookahead >= max possible (lead + grace). This guards the historical
    // bug where an 8-day lookahead silently dropped a 14-day-configurable lead.
    const worst = cfg({
      leadMinutes: [MAX_LEAD_MINUTES],
      nudgeMinutes: MAX_LEAD_MINUTES,
    });
    expect(maxLookaheadMinutes(worst)).toBe(REMINDER_LOOKAHEAD_MINUTES);
    expect(REMINDER_LOOKAHEAD_MINUTES).toBeGreaterThanOrEqual(
      MAX_LEAD_MINUTES + REMINDER_GRACE_MIN,
    );
  });
});

describe("dueReminders", () => {
  it("fires a lead exactly at its threshold", () => {
    const now = start - 60 * MIN; // exactly 1h before
    const due = dueReminders(cfg(), start, now);
    expect(due.map((d) => d.kind)).toEqual(["lead:60"]);
  });

  it("fires within the grace window but not before the threshold or after grace", () => {
    expect(dueReminders(cfg(), start, start - 61 * MIN).map((d) => d.kind)).toEqual([]); // too early for 60
    expect(dueReminders(cfg(), start, start - 60 * MIN).map((d) => d.kind)).toEqual(["lead:60"]);
    expect(
      dueReminders(cfg(), start, start - (60 - REMINDER_GRACE_MIN + 1) * MIN).map((d) => d.kind),
    ).toEqual([]); // past grace (and past start side) → closed
  });

  it("fires the 24h lead and the 12h nudge in their own windows", () => {
    expect(dueReminders(cfg(), start, start - 1440 * MIN).map((d) => d.kind)).toEqual(["lead:1440"]);
    const nudge = dueReminders(cfg(), start, start - 720 * MIN);
    expect(nudge.map((d) => d.kind)).toEqual(["nudge"]);
    expect(nudge[0]!.audience).toBe("no-response");
  });

  it("returns nothing once the event has started or for a disabled config", () => {
    expect(dueReminders(cfg(), start, start)).toEqual([]);
    expect(dueReminders(cfg(), start, start + 1)).toEqual([]);
    expect(dueReminders(cfg({ enabled: false }), start, start - 60 * MIN)).toEqual([]);
  });

  it("no nudge when nudgeMinutes is null", () => {
    expect(dueReminders(cfg({ nudgeMinutes: null }), start, start - 720 * MIN)).toEqual([]);
  });
});
