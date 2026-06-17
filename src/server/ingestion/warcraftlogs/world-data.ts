/**
 * Pure helpers for interpreting WCL `worldData.zones`. No I/O — imported by
 * BOTH the persistence job (wcl-worlddata-refresh.ts) and the live resolver
 * fallback (client.ts), so detection logic lives in exactly one place.
 *
 * The key insight (live-verified 2026-06-17): a zone's TYPE is read from its
 * `difficulties`, not its name. Raids carry difficulty ids 3/4/5
 * (Normal/Heroic/Mythic); Mythic+ zones carry 10 (Dungeon); Delves carry
 * 108/109. So "is a raid" = has a raid difficulty id — far more robust than the
 * old name-regex that excluded /PTR|M\+|delve/.
 */

export type WorldDataZone = {
  id: number;
  name?: string | null;
  frozen?: boolean | null;
  difficulties?: Array<{ id: number; name?: string | null }> | null;
  encounters?: Array<{ id: number; name?: string | null }> | null;
  expansion?: { id?: number | null; name?: string | null } | null;
};

/** Normal / Heroic / Mythic raid difficulty ids (LFR=1 co-occurs but is alone
 *  ambiguous; 3/4/5 never appear on M+/Delve zones). */
export const RAID_DIFFICULTY_IDS = new Set([3, 4, 5]);

/** A zone is a RAID iff it exposes a raid difficulty (3/4/5). */
export function isRaidZone(z: WorldDataZone): boolean {
  return (z.difficulties ?? []).some((d) => RAID_DIFFICULTY_IDS.has(d.id));
}

/**
 * The CURRENT RELEASE's raid zones — the full set the app tracks together.
 *
 * In WoW versioning `expansion.release.patch`, a RELEASE (the middle number)
 * defines a set of raid tiers; PATCHES add raids to that set (additive); the
 * next release REPLACES the set. WCL encodes this with `frozen`: the prior
 * release's raids freeze when a new release launches, so the live release =
 * ALL non-frozen raid zones in the current expansion.
 *
 * Example (Midnight 12.0.7): zone 46 "VS / DR / MQD" (12.0.0 launch, 9 bosses)
 * AND zone 50 "Sporefall" (12.0.7 patch, Rotmire) are BOTH non-frozen → BOTH
 * tracked. Returned sorted by id ascending (release/chronological order).
 *
 * Scoped to the expansion of the NEWEST non-frozen raid so a stray non-frozen
 * old-expansion raid can't leak in.
 *
 * ASSUMPTION (re-verify at the next `.release` bump, e.g. 12.1.0): relies on
 * WCL freezing the prior release's raids when a new release launches. If WCL
 * ever keeps them non-frozen across a release, this would over-include and we'd
 * need an explicit release-boundary signal (or the WCL_RAID_ZONE_ID override).
 */
export function pickCurrentReleaseRaidZones(
  zones: WorldDataZone[],
): WorldDataZone[] {
  const raids = zones.filter((z) => z.frozen !== true && isRaidZone(z));
  if (raids.length === 0) return [];
  const newest = [...raids].sort((a, b) => b.id - a.id)[0]!;
  const expId = newest.expansion?.id ?? null;
  return raids
    .filter((z) => (z.expansion?.id ?? null) === expId)
    .sort((a, b) => a.id - b.id);
}

/**
 * The single PRIMARY (newest) current-release raid zone — for the few places
 * that genuinely need one id (calendar default art, an ingestion seed).
 */
export function pickCurrentRaidZone(
  zones: WorldDataZone[],
): WorldDataZone | null {
  const set = pickCurrentReleaseRaidZones(zones);
  return set.length > 0 ? set[set.length - 1]! : null;
}
