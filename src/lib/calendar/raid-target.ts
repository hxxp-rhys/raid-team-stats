/**
 * Raid-lead targeting model. The AUTHORITATIVE shape is `targetOrder`: an
 * ordered list of entries, each either a whole raid ZONE or a single boss
 * (encounter) within a zone. The order is the planned kill order the raid lead
 * sets, and the month-view zone art is driven by the FIRST TWO entries.
 *
 * The flat `targetZoneIds` / `targetEncounterIds` arrays are DERIVED from the
 * order and persisted alongside it purely for back-compat (older readers, the
 * Discord board, and pre-migration rows that have no `targetOrder` yet — those
 * fall back to the flat arrays). Pure + isomorphic: imported by the calendar
 * router/materializer (server) and the event form + month view (client).
 */

import { z } from "zod";

/** Generous cap on ordered entries (a tier rarely exceeds ~10 bosses/zone). */
export const RAID_TARGET_MAX = 60;

export type RaidTargetType = "zone" | "encounter";

/**
 * One ordered entry. `zoneId` is ALWAYS the Blizzard journal-instance id of the
 * raid the entry belongs to (for a `zone` entry it equals `id`); for an
 * `encounter` entry `id` is the boss's encounter id and `zoneId` its raid — so
 * the month view can resolve every entry to a zone tile without a lookup.
 */
export type RaidTargetItem = {
  type: RaidTargetType;
  id: number;
  zoneId: number;
};

export const raidTargetItemSchema = z.object({
  type: z.enum(["zone", "encounter"]),
  id: z.number().int(),
  zoneId: z.number().int(),
});

export const raidTargetOrderSchema = z
  .array(raidTargetItemSchema)
  .max(RAID_TARGET_MAX);

/** Validate a stored JSON blob into a clean ordered list (invalid → []). */
export function parseRaidTargetOrder(raw: unknown): RaidTargetItem[] {
  const res = raidTargetOrderSchema.safeParse(raw);
  return res.success ? res.data : [];
}

/**
 * Derive the back-compat flat arrays from the ordered list. Zones are the
 * distinct `zoneId`s in first-seen order (so a zone is listed even when only
 * some of its bosses are targeted); encounters are the `encounter` entries'
 * ids in order.
 */
export function deriveTargetArrays(order: RaidTargetItem[]): {
  targetZoneIds: number[];
  targetEncounterIds: number[];
} {
  const targetZoneIds: number[] = [];
  const targetEncounterIds: number[] = [];
  for (const item of order) {
    if (!targetZoneIds.includes(item.zoneId)) targetZoneIds.push(item.zoneId);
    if (item.type === "encounter") targetEncounterIds.push(item.id);
  }
  return { targetZoneIds, targetEncounterIds };
}

/**
 * The zone ids of the FIRST TWO ordered entries (deduped, ≤2) — the raids the
 * month view paints. With no `targetOrder` (pre-migration rows) the caller
 * falls back to the first two of `targetZoneIds`.
 */
export function leadingZoneIds(order: RaidTargetItem[]): number[] {
  const out: number[] = [];
  for (const item of order.slice(0, 2)) {
    if (!out.includes(item.zoneId)) out.push(item.zoneId);
  }
  return out;
}
