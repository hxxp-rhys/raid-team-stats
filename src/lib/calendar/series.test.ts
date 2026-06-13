import { describe, expect, it } from "vitest";

import { reconcileSeries, type ExistingSeriesEvent } from "./series";
import type { Occurrence } from "./occurrence";

const occ = (date: string): Occurrence => ({
  occurrenceDate: date,
  localTime: "19:00",
  timezone: "Europe/London",
  startsAt: new Date(`${date}T18:00:00Z`),
});

const ev = (over: Partial<ExistingSeriesEvent> & { id: string; occurrenceDate: string }): ExistingSeriesEvent => ({
  seriesOverride: false,
  status: "PLANNED",
  signupCount: 0,
  ...over,
});

describe("reconcileSeries", () => {
  it("creates desired dates with no existing event", () => {
    const plan = reconcileSeries([occ("2026-06-16"), occ("2026-06-18")], []);
    expect(plan.toCreate.map((o) => o.occurrenceDate)).toEqual(["2026-06-16", "2026-06-18"]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toCancel).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("re-times existing PLANNED occurrences that are still scheduled", () => {
    const plan = reconcileSeries(
      [occ("2026-06-16")],
      [ev({ id: "e1", occurrenceDate: "2026-06-16" })],
    );
    expect(plan.toUpdate).toEqual([{ id: "e1", occurrence: occ("2026-06-16") }]);
    expect(plan.toCreate).toEqual([]);
  });

  it("cancels a de-scheduled occurrence that has signups (keeps history)", () => {
    const plan = reconcileSeries(
      [],
      [ev({ id: "e1", occurrenceDate: "2026-06-16", signupCount: 3 })],
    );
    expect(plan.toCancel).toEqual(["e1"]);
    expect(plan.toDelete).toEqual([]);
  });

  it("deletes a de-scheduled EMPTY placeholder", () => {
    const plan = reconcileSeries(
      [],
      [ev({ id: "e1", occurrenceDate: "2026-06-16", signupCount: 0 })],
    );
    expect(plan.toDelete).toEqual(["e1"]);
    expect(plan.toCancel).toEqual([]);
  });

  it("NEVER touches a pinned (seriesOverride) occurrence, and won't recreate its date", () => {
    const plan = reconcileSeries(
      [occ("2026-06-16")], // series still wants this date
      [ev({ id: "e1", occurrenceDate: "2026-06-16", seriesOverride: true })],
    );
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toCreate).toEqual([]); // date slot already occupied by the override
    expect(plan.toCancel).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("NEVER resurrects or re-cancels a CANCELLED occurrence, even if still desired", () => {
    const plan = reconcileSeries(
      [occ("2026-06-16")],
      [ev({ id: "e1", occurrenceDate: "2026-06-16", status: "CANCELLED", signupCount: 2 })],
    );
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toCreate).toEqual([]); // slot occupied — no duplicate
    expect(plan.toCancel).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("leaves a LOCKED occurrence alone (committed roster), whether or not still scheduled", () => {
    const stillWanted = reconcileSeries(
      [occ("2026-06-16")],
      [ev({ id: "e1", occurrenceDate: "2026-06-16", status: "LOCKED", signupCount: 5 })],
    );
    expect(stillWanted.toUpdate).toEqual([]);
    expect(stillWanted.toCreate).toEqual([]);

    const noLongerWanted = reconcileSeries(
      [],
      [ev({ id: "e1", occurrenceDate: "2026-06-16", status: "LOCKED", signupCount: 5 })],
    );
    expect(noLongerWanted.toCancel).toEqual([]);
    expect(noLongerWanted.toDelete).toEqual([]);
  });

  it("handles a mixed plan: add a day, drop a day, keep a day, respect an override", () => {
    const desired = [occ("2026-06-16"), occ("2026-06-18")]; // Tue + Thu
    const existing = [
      ev({ id: "tue", occurrenceDate: "2026-06-16" }), // keep → update
      ev({ id: "wed", occurrenceDate: "2026-06-17", signupCount: 4 }), // dropped, has signups → cancel
      ev({ id: "fri", occurrenceDate: "2026-06-19" }), // dropped, empty → delete
      ev({ id: "pin", occurrenceDate: "2026-06-20", seriesOverride: true }), // pinned → skip
    ];
    const plan = reconcileSeries(desired, existing);
    expect(plan.toCreate.map((o) => o.occurrenceDate)).toEqual(["2026-06-18"]);
    expect(plan.toUpdate.map((u) => u.id)).toEqual(["tue"]);
    expect(plan.toCancel).toEqual(["wed"]);
    expect(plan.toDelete).toEqual(["fri"]);
  });
});
