/**
 * Single source of truth for the LATEST published companion + addon versions,
 * plus the numeric version comparison used to decide whether a user's installed
 * companion is out of date.
 *
 * These constants MUST be bumped in lockstep with the installer
 * (`installer/Package.wxs` `Version`) and the addon (`addon/StatSmith/StatSmith.toc`
 * `## Version` / `StatSmith.lua` `ADDON_VERSION`) on every companion/addon
 * release — see the wow-patch-upgrade skill §3 register.
 */

/** = installer/Package.wxs Version. Bump on every companion release. */
export const LATEST_COMPANION_VERSION = "1.0.36.0";

/** = addon StatSmith.toc "## Version" / StatSmith.lua ADDON_VERSION. Bump on every addon release. */
export const LATEST_ADDON_VERSION = "1.2.9";

/**
 * Opt-in addon auto-update (Phase 3b-ii). These two bump in lockstep with the
 * addon (and the coupled companion that ships the auto-apply transport):
 *
 *  - MIN_COMPANION_FOR_ADDON: the first companion build that can safely fetch,
 *    integrity-check, and (gated) apply an addon bundle. Older companions must
 *    NOT auto-apply, so the manifest advertises this floor and the companion
 *    self-gates on it.
 *  - ADDON_BUNDLE_URL: the GitHub "latest release" asset built by
 *    scripts/build-addon-bundle.mjs and published by installer-release.yml
 *    (mirrors DEFAULT_INSTALLER_URL's central-hosting style).
 */
export const MIN_COMPANION_FOR_ADDON = "1.0.24.0"; // first companion that can safely auto-apply an addon update (compat gate)
export const ADDON_BUNDLE_URL =
  "https://github.com/hxxp-rhys/raid-team-stats/releases/latest/download/raid-team-stats-addon.json";

/**
 * Compare two dotted version strings NUMERICALLY (segment-by-segment), not
 * lexically — so "1.0.22.0" > "1.0.9.0" (22 > 9), which a string compare gets
 * wrong. The shorter version is zero-padded to the longer's length, so
 * "1.2.2" and "1.2.2.0" compare equal.
 *
 * @returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    // Missing trailing segments are treated as 0 (zero-pad the shorter).
    const an = parseInt(as[i] ?? "0", 10) || 0;
    const bn = parseInt(bs[i] ?? "0", 10) || 0;
    if (an < bn) return -1;
    if (an > bn) return 1;
  }
  return 0;
}

/**
 * Is `installed` strictly older than `latest`? Returns false (NOT outdated) for
 * a null/empty/unparseable installed version — we never nag a user we can't
 * reliably place behind the latest release.
 */
export function isOutdated(
  installed: string | null | undefined,
  latest: string,
): boolean {
  if (!installed) return false;
  // Reject a version string with no numeric content at all (e.g. "garbage").
  // A version that parses to all-zeros (0.0.0) is still a valid-but-ancient
  // version; only a string with ZERO parseable numeric segments is unusable.
  const hasNumericSegment = installed
    .split(".")
    .some((seg) => Number.isFinite(parseInt(seg, 10)));
  if (!hasNumericSegment) return false;
  return compareVersions(installed, latest) < 0;
}

/**
 * Should we notify this user about the latest companion release? True only when
 * their last-seen companion is outdated AND we have NOT already notified them
 * about this exact latest version (so a user who was notified about an older
 * release gets notified again when a newer one ships).
 */
export function shouldNotify(
  state: { lastSeenVersion: string | null; notifiedUpdateVersion: string | null },
  latest: string,
): boolean {
  return (
    isOutdated(state.lastSeenVersion, latest) &&
    state.notifiedUpdateVersion !== latest
  );
}
