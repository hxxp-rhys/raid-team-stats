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
  nudgeMinutes: [720],
  ...over,
});

describe("parseReminderConfig", () => {
  it("returns defaults for null/garbage", () => {
    expect(parseReminderConfig(null)).toEqual(DEFAULT_REMINDER_CONFIG);
    expect(parseReminderConfig(42)).toEqual(DEFAULT_REMINDER_CONFIG);
  });

  it("sanitizes: dedupes + sorts leads/nudges desc, drops non-positive", () => {
    expect(
      parseReminderConfig({
        enabled: false,
        leadMinutes: [60, 1440, 60, -5, 0, 30.4],
        nudgeMinutes: [720, 360, 720, 0, -1, 90.6],
      }),
    ).toEqual({ enabled: false, leadMinutes: [1440, 60, 30], nudgeMinutes: [720, 360, 91] });
  });

  it("empty/missing nudges → no nudges; back-compat coerces a legacy scalar", () => {
    expect(parseReminderConfig({ nudgeMinutes: [] }).nudgeMinutes).toEqual([]);
    expect(parseReminderConfig({ nudgeMinutes: null }).nudgeMinutes).toEqual([]);
    expect(parseReminderConfig({}).nudgeMinutes).toEqual(DEFAULT_REMINDER_CONFIG.nudgeMinutes);
    // legacy single-scalar form written by the pre-multi-nudge version
    expect(parseReminderConfig({ nudgeMinutes: 720 }).nudgeMinutes).toEqual([720]);
  });

  it("preserves a custom nudge email template (trim) across the round-trip", () => {
    const parsed = parseReminderConfig({
      nudgeMinutes: [720],
      nudgeTemplate: { subject: "  Hi {{ char_name }}  ", body: "  Body  " },
    });
    expect(parsed.nudgeTemplate).toEqual({ subject: "Hi {{ char_name }}", body: "Body" });
    // a SECOND save (re-parse of the parsed output) is stable — not dropped
    expect(parseReminderConfig(parsed).nudgeTemplate).toEqual({
      subject: "Hi {{ char_name }}",
      body: "Body",
    });
  });

  it("drops an empty/whitespace-only template; absent → no key", () => {
    expect(
      parseReminderConfig({ nudgeTemplate: { subject: "   ", body: "" } }).nudgeTemplate,
    ).toBeUndefined();
    expect(parseReminderConfig({ nudgeTemplate: {} }).nudgeTemplate).toBeUndefined();
    expect("nudgeTemplate" in parseReminderConfig({})).toBe(false);
  });
});

describe("maxLookaheadMinutes", () => {
  it("is the largest lead/nudge plus grace", () => {
    expect(maxLookaheadMinutes(cfg())).toBe(1440 + REMINDER_GRACE_MIN);
    expect(maxLookaheadMinutes(cfg({ leadMinutes: [30], nudgeMinutes: [] }))).toBe(30 + REMINDER_GRACE_MIN);
    // a nudge can be the largest entry
    expect(maxLookaheadMinutes(cfg({ leadMinutes: [30], nudgeMinutes: [2880] }))).toBe(2880 + REMINDER_GRACE_MIN);
  });

  it("the sweep lookahead covers the worst-case storable config (no drift)", () => {
    const worst = cfg({
      leadMinutes: [MAX_LEAD_MINUTES],
      nudgeMinutes: [MAX_LEAD_MINUTES],
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
    expect(nudge.map((d) => d.kind)).toEqual(["nudge:720"]);
    expect(nudge[0]!.audience).toBe("no-response");
  });

  it("fires multiple nudges, each in its own window with a distinct kind", () => {
    const c = cfg({ leadMinutes: [], nudgeMinutes: [1440, 360, 60] });
    expect(dueReminders(c, start, start - 1440 * MIN).map((d) => d.kind)).toEqual(["nudge:1440"]);
    expect(dueReminders(c, start, start - 360 * MIN).map((d) => d.kind)).toEqual(["nudge:360"]);
    expect(dueReminders(c, start, start - 60 * MIN).map((d) => d.kind)).toEqual(["nudge:60"]);
    // every nudge carries the no-response audience
    expect(dueReminders(c, start, start - 60 * MIN)[0]!.audience).toBe("no-response");
  });

  it("returns nothing once the event has started or for a disabled config", () => {
    expect(dueReminders(cfg(), start, start)).toEqual([]);
    expect(dueReminders(cfg(), start, start + 1)).toEqual([]);
    expect(dueReminders(cfg({ enabled: false }), start, start - 60 * MIN)).toEqual([]);
  });

  it("no nudge when nudgeMinutes is empty", () => {
    expect(dueReminders(cfg({ nudgeMinutes: [] }), start, start - 720 * MIN)).toEqual([]);
  });
});
