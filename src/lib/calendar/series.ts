/**
 * Pure reconciliation for a recurring series edit. Given the DESIRED future
 * occurrences (from `enumerateOccurrences` after an edit) and the EXISTING
 * future events already materialized for the series, decide what to create,
 * re-time, cancel, or delete.
 *
 * Invariants this enforces (the whole reason it's a pure, tested function):
 *  - An occurrence a leader pinned for itself (`seriesOverride`) is NEVER
 *    touched by a series edit — "edit this event" wins over "edit the series".
 *  - A LOCKED occurrence (roster finalized) and a CANCELLED occurrence are
 *    likewise left alone — series edits don't silently move a committed night
 *    or resurrect a cancelled one.
 *  - A no-longer-scheduled occurrence with signups is CANCELLED (history kept),
 *    not hard-deleted; only an empty placeholder is deleted. (Exception: the
 *    `hardDelete` mode — used by "Delete raid" on a recurring raid — routes
 *    EVERY de-scheduled future occurrence to hard-delete regardless of signups,
 *    so the series disappears from the Month view entirely. Pinned/locked/
 *    cancelled occurrences are still left alone; past occurrences aren't passed
 *    here at all, so attendance history survives.)
 *  - We never create a second event on a date that already has ANY event for
 *    the series (the (seriesId, occurrenceDate) unique key would reject it).
 */

import type { Occurrence } from "./occurrence";

export type ExistingSeriesEvent = {
  id: string;
  occurrenceDate: string;
  seriesOverride: boolean;
  status: "PLANNED" | "LOCKED" | "CANCELLED" | string;
  signupCount: number;
};

export type ReconcilePlan = {
  /** Desired occurrences with no event yet — create them. */
  toCreate: Occurrence[];
  /** Existing PLANNED occurrences still scheduled — re-time / refresh fields. */
  toUpdate: { id: string; occurrence: Occurrence }[];
  /** Existing PLANNED occurrences with signups, no longer scheduled — soft-cancel. */
  toCancel: string[];
  /** Existing empty PLANNED occurrences no longer scheduled — hard-delete. */
  toDelete: string[];
};

/** True if a series edit must leave this occurrence exactly as-is. */
function isPinned(e: ExistingSeriesEvent): boolean {
  return e.seriesOverride || e.status === "LOCKED" || e.status === "CANCELLED";
}

export function reconcileSeries(
  desired: Occurrence[],
  existing: ExistingSeriesEvent[],
  opts?: {
    /**
     * Hard-delete EVERY de-scheduled future occurrence (even ones with signups),
     * instead of soft-cancelling the signed-up ones. Used by "Delete raid" on a
     * recurring raid so the whole series leaves the Month view; the default
     * (false) keeps the cancel-signed-up behavior the series editor / "End
     * series" rely on. Pinned/locked/cancelled occurrences are still skipped.
     */
    hardDelete?: boolean;
  },
): ReconcilePlan {
  const desiredByDate = new Map(desired.map((o) => [o.occurrenceDate, o]));
  const existingDates = new Set(existing.map((e) => e.occurrenceDate));
  const hardDelete = opts?.hardDelete ?? false;

  const plan: ReconcilePlan = {
    toCreate: [],
    toUpdate: [],
    toCancel: [],
    toDelete: [],
  };

  for (const e of existing) {
    if (isPinned(e)) continue; // override / locked / cancelled — never auto-touch
    const stillScheduled = desiredByDate.get(e.occurrenceDate);
    if (stillScheduled) {
      plan.toUpdate.push({ id: e.id, occurrence: stillScheduled });
    } else if (e.signupCount > 0 && !hardDelete) {
      plan.toCancel.push(e.id); // keep signup history
    } else {
      // Empty placeholder, OR (in hardDelete mode) any de-scheduled occurrence
      // regardless of signups — removed entirely so it leaves the Month view.
      plan.toDelete.push(e.id);
    }
  }

  for (const o of desired) {
    // Any existing row (active, pinned, or cancelled) on this date occupies the
    // unique slot — only create where nothing exists yet.
    if (!existingDates.has(o.occurrenceDate)) plan.toCreate.push(o);
  }

  return plan;
}
