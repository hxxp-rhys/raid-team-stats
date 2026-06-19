/**
 * Addon-as-primary / API-fallback field resolver (Phase 5).
 *
 * For a SAFE subset of character fields the in-game addon is the more
 * authoritative source (it reads live client state the web APIs lag or
 * can't see — e.g. the exact equipped item level, the exact weekly M+ run
 * count). For those fields we prefer the addon's value when it is FRESH,
 * and otherwise fall back to the API value (which is also the source for
 * users who never installed the companion).
 *
 * Pure + dependency-free so it is trivially unit-testable and safe to import
 * on the server (no DB, no I/O).
 *
 * NOT for: WCL parses, Raider.IO score, the talent loadout, raid
 * completions, or the gear audit — those stay API-only / API-primary.
 */

export type FieldSource = "addon" | "api";

/** Default freshness window: an addon capture older than 24h is stale. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Is the character's most-recent addon capture fresh enough to be trusted
 * as primary?
 *
 * True ONLY when the companion is actively reporting (`companionState ===
 * "ok"`), we actually have a capture timestamp, and that capture is within
 * `maxAgeMs` of `now`. A `none`/`warning` companion state (no install, or
 * no data in the staleness window) is NEVER fresh — this dovetails with the
 * roster "App" column, which already flags those as stale/absent.
 */
export function isAddonFresh(args: {
  collectedAt: Date | null;
  companionState: "none" | "ok" | "warning";
  now: number;
  maxAgeMs?: number;
}): boolean {
  const { collectedAt, companionState, now } = args;
  const maxAgeMs = args.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (companionState !== "ok") return false;
  if (collectedAt == null) return false;
  return now - collectedAt.getTime() <= maxAgeMs;
}

/**
 * Resolve a single field to its preferred value + the source it came from.
 *
 * Addon wins only when it is fresh AND actually has a (non-null) value;
 * otherwise the API value is used (or null when neither side has one).
 */
export function resolveField<T>(args: {
  addonValue: T | null | undefined;
  apiValue: T | null | undefined;
  addonFresh: boolean;
}): { value: T | null; source: FieldSource } {
  const { addonValue, apiValue, addonFresh } = args;
  if (addonFresh && addonValue != null) {
    return { value: addonValue, source: "addon" };
  }
  return { value: apiValue ?? null, source: "api" };
}
