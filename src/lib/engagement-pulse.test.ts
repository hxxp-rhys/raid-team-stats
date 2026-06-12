import { describe, expect, it } from "vitest";

import {
  absenceSignal,
  activitySignal,
  closedWeekStarts,
  decayFlag,
  loginSignal,
  medianOf,
  mplusSignal,
  riskScore,
  watchlisted,
  weekStartUtc,
} from "./engagement-pulse";

describe("weekStartUtc", () => {
  it("pins a mid-week date to the previous Tuesday 15:00 UTC", () => {
    // Friday 2026-06-12 06:00 UTC → Tuesday 2026-06-09 15:00 UTC
    const ws = weekStartUtc(new Date(Date.UTC(2026, 5, 12, 6, 0, 0)));
    expect(ws.toISOString()).toBe("2026-06-09T15:00:00.000Z");
  });

  it("rolls back a full week when 'now' is Tuesday before reset", () => {
    // Tuesday 2026-06-09 14:59 UTC is still the PRIOR raid week
    const ws = weekStartUtc(new Date(Date.UTC(2026, 5, 9, 14, 59, 0)));
    expect(ws.toISOString()).toBe("2026-06-02T15:00:00.000Z");
  });

  it("keeps Tuesday after reset in the same week", () => {
    const ws = weekStartUtc(new Date(Date.UTC(2026, 5, 9, 15, 0, 0)));
    expect(ws.toISOString()).toBe("2026-06-09T15:00:00.000Z");
  });
});

describe("closedWeekStarts", () => {
  it("returns the N weeks before the current one, oldest first", () => {
    const now = new Date(Date.UTC(2026, 5, 12, 6, 0, 0)); // week of 06-09
    const weeks = closedWeekStarts(now, 3);
    expect(weeks.map((w) => w.toISOString())).toEqual([
      "2026-05-19T15:00:00.000Z",
      "2026-05-26T15:00:00.000Z",
      "2026-06-02T15:00:00.000Z",
    ]);
  });
});

describe("medianOf", () => {
  it("handles odd, even, and empty inputs", () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
    expect(medianOf([])).toBeNull();
  });
});

describe("decayFlag", () => {
  it("flags two consecutive weeks at ≤ half the prior baseline", () => {
    // baseline window [4,4,4,4] → 4; recent [1, 2] both ≤ 2
    const d = decayFlag([4, 4, 4, 4, 1, 2]);
    expect(d.baseline).toBe(4);
    expect(d.flagged).toBe(true);
  });

  it("does not let the dropoff weeks drag down their own baseline", () => {
    // If [0,0] were included in the median the baseline would sink; the
    // preceding-window design keeps baseline = 4 and the flag on.
    const d = decayFlag([4, 4, 4, 0, 0]);
    expect(d.baseline).toBe(4);
    expect(d.flagged).toBe(true);
  });

  it("requires baseline ≥ 2 (a 0–1 vault-week player can't 'decay')", () => {
    const d = decayFlag([1, 1, 1, 1, 0, 0]);
    expect(d.flagged).toBe(false);
  });

  it("requires ≥ 4 known closed weeks", () => {
    expect(decayFlag([4, 0, 0]).flagged).toBe(false);
    expect(decayFlag([null, null, 4, 0, 0]).flagged).toBe(false);
  });

  it("never treats unknown weeks as inactive", () => {
    // last week unknown (sync gap) → no flag, even after a zero week
    const d = decayFlag([4, 4, 4, 4, 0, null]);
    expect(d.flagged).toBe(false);
    // unknowns inside the baseline window are skipped, not zeroed
    const d2 = decayFlag([4, null, 4, null, 4, 4, 1, 1]);
    expect(d2.baseline).toBe(4);
    expect(d2.flagged).toBe(true);
    // discriminating case: a mostly-unknown baseline window. Skipping nulls
    // gives [4, 4] → median 4 → flagged; zeroing them would give
    // [4, 0, 0, 0, 4] → median 0 → unflagged. Pins the baseline path.
    const d3 = decayFlag([4, null, null, null, 4, 1, 1]);
    expect(d3.baseline).toBe(4);
    expect(d3.flagged).toBe(true);
  });

  it("stays off when only one recent week dipped", () => {
    const d = decayFlag([4, 4, 4, 4, 0, 4]);
    expect(d.flagged).toBe(false);
  });
});

describe("signals", () => {
  it("activitySignal: 1 when flagged, 0.5 on a single-week dip", () => {
    expect(activitySignal(decayFlag([4, 4, 4, 4, 1, 1]))).toBe(1);
    expect(activitySignal(decayFlag([4, 4, 4, 4, 4, 1]))).toBe(0.5);
    expect(activitySignal(decayFlag([4, 4, 4, 4, 4, 4]))).toBe(0);
  });

  it("loginSignal buckets days-offline and never penalizes unknown", () => {
    expect(loginSignal(null)).toBe(0);
    expect(loginSignal(3)).toBe(0);
    expect(loginSignal(7)).toBe(0.5);
    expect(loginSignal(14)).toBe(1);
  });

  it("mplusSignal gates on previous-season ≥ 500", () => {
    expect(mplusSignal(100, 400)).toBe(0); // casual last season → noise
    expect(mplusSignal(100, 2000)).toBe(1); // collapse
    expect(mplusSignal(1200, 2000)).toBe(0.5); // decline
    expect(mplusSignal(1900, 2000)).toBe(0);
    expect(mplusSignal(null, 2000)).toBe(1); // no score at all this season
    expect(mplusSignal(1000, null)).toBe(0);
  });

  it("absenceSignal saturates at 1", () => {
    expect(absenceSignal(0)).toBe(0);
    expect(absenceSignal(1)).toBe(0.5);
    expect(absenceSignal(2)).toBe(1);
    expect(absenceSignal(5)).toBe(1);
  });
});

describe("riskScore + watchlisted", () => {
  it("weights activity highest", () => {
    expect(
      riskScore({ activity: 1, login: 0, mplus: 0, absence: 0 }),
    ).toBeCloseTo(0.4);
    expect(
      riskScore({ activity: 0, login: 1, mplus: 1, absence: 1 }),
    ).toBeCloseTo(0.6);
  });

  it("requires at least two independent signals (vacation ≠ churn)", () => {
    // Strong single signal — ranks but never lists.
    expect(watchlisted({ activity: 1, login: 0, mplus: 0, absence: 0 })).toBe(
      false,
    );
    // Two agreeing signals over the floor → listed.
    expect(
      watchlisted({ activity: 1, login: 0.5, mplus: 0, absence: 0 }),
    ).toBe(true);
    // Two weak signals under the floor → not listed.
    expect(
      watchlisted({ activity: 0, login: 0.5, mplus: 0, absence: 0.5 }),
    ).toBe(false);
  });
});
