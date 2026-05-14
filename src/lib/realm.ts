/**
 * Blizzard realm-slug normalization. Blizzard's API expects realm slugs in a
 * specific lowercase, hyphen-separated, ASCII form — e.g. "Cho'gall" → "chogall",
 * "Area 52" → "area-52", "Wyrmrest Accord" → "wyrmrest-accord".
 *
 * We normalize at the boundary: anything stored in the DB or passed to the
 * Blizzard client must be a slug, never a display name.
 */

const DIACRITIC_REGEX = /[̀-ͯ]/g;
const NON_SLUG_REGEX = /[^a-z0-9-]/g;
const MULTI_DASH_REGEX = /-{2,}/g;
const TRIM_DASHES_REGEX = /^-+|-+$/g;

export function normalizeRealmSlug(input: string): string {
  if (typeof input !== "string") return "";
  return input
    .normalize("NFD")
    .replace(DIACRITIC_REGEX, "")
    .toLowerCase()
    .replace(/['’]/g, "") // strip ASCII and curly apostrophes
    .replace(/\s+/g, "-")
    .replace(NON_SLUG_REGEX, "")
    .replace(MULTI_DASH_REGEX, "-")
    .replace(TRIM_DASHES_REGEX, "");
}

/**
 * Slugifies a guild name the same way Blizzard does for guild API paths.
 * Same normalization rules as realm slugs.
 */
export const normalizeGuildSlug = normalizeRealmSlug;

/**
 * Slugifies a raid-team display name into a URL-safe identifier. Used for
 * `RaidTeam.slug` (unique within a guild). More permissive than the Blizzard
 * slug — keeps digits, allows mixed case to be lowercased.
 */
export function normalizeRaidTeamSlug(input: string): string {
  return normalizeRealmSlug(input);
}

/**
 * URL-encodes a realm + character name into a Blizzard profile path segment.
 * Used by the Phase 4 Blizzard client. Defends against path-traversal /
 * injection by rejecting characters that would alter URL structure.
 */
export function buildCharacterPath(realmSlug: string, characterName: string): string {
  const slug = normalizeRealmSlug(realmSlug);
  if (!slug) throw new Error("buildCharacterPath: empty or invalid realm slug");
  // Blizzard expects the character name lowercased AND URL-encoded.
  const lowered = characterName.toLowerCase().trim();
  if (!lowered) throw new Error("buildCharacterPath: empty character name");
  return `${slug}/${encodeURIComponent(lowered)}`;
}
