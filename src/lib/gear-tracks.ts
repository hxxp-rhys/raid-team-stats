/**
 * Single source of truth for the WoW "Gear Upgrade Tracks" colour
 * mapping used across the dashboard (tier-set tracker pips, Great Vault
 * pips, anywhere a track is rendered). Per the project brand spec:
 *
 *   Adventurer → Gray
 *   Veteran    → Green
 *   Champion   → Blue
 *   Hero       → Purple
 *   Myth       → Orange
 *
 * Any new widget that shows a track MUST import from here — never
 * hardcode the colour in the component.
 */

export type GearTrack =
  | "adventurer"
  | "veteran"
  | "champion"
  | "hero"
  | "myth";

/**
 * Highest item level a character can legitimately reach in the current
 * expansion — the Voidforged (Ascendant Voidcore) Myth-track ceiling. Midnight
 * Season 1: base Mythic 289, Voidforged 298 (both Blizzard-verified from stored
 * equipment; see trackForItemLevel). Anything above this is anomalous (a data
 * error or unaccounted-for new content). UNVERIFIED for 12.0.7 Sporefall — bump
 * here if that raises the cap.
 */
export const MAX_ITEM_LEVEL = 298;

/** Tailwind background class for a filled track pip / dot. */
export const GEAR_TRACK_BG: Record<GearTrack, string> = {
  adventurer: "bg-gray-400",
  veteran: "bg-green-500",
  champion: "bg-blue-500",
  hero: "bg-purple-500",
  myth: "bg-orange-500",
};

/** Human label used in tooltips ("Hero (ilvl 707)"). */
export const GEAR_TRACK_LABEL: Record<GearTrack, string> = {
  adventurer: "Adventurer",
  veteran: "Veteran",
  champion: "Champion",
  hero: "Hero",
  myth: "Myth",
};

/**
 * Map an equipped item level to its Midnight (12.0) gear-upgrade track.
 *
 * Thresholds are the documented Season 1 track BASE ilvls — "5 upgrade tracks
 * × 6 ranks (Adventurer 220–237 … Myth 272–289)" with raid drop bands
 * LFR 233–250 / N 246–263 / H 259–276 / M 272–289, the live 289/298 anchors
 * Blizzard-verified against stored equipment (research §1.1, docs/research/
 * widget-and-preparedness-research.md:132,134). The bases step +13:
 *   Myth ≥272 · Hero ≥259 · Champion ≥246 · Veteran ≥233 · else Adventurer.
 * Adjacent tracks overlap ~4 ilvls (e.g. a 272–276 piece is Myth rank-1 OR a
 * fully-upgraded Hero piece); we assign the overlap to the HIGHER track, since
 * un-upgraded base-rank items dominate. The only way to resolve those exactly
 * is the upgrade-track bonus-ID map (research A.7 #2, still UNVERIFIED) — wire
 * that in here when settled; this stays the single source of truth.
 *
 * NOTE: the pre-Midnight code used The War Within bands (Myth ≥707) which, on
 * post-squish Midnight ilvls, mis-classified every 289 Mythic piece as
 * Veteran. Drives the tier-set tracker dot colours; pairs with GEAR_TRACK_BG
 * so the dots share the Great Vault palette.
 */
export function trackForItemLevel(
  ilvl: number | null | undefined,
): GearTrack | null {
  if (typeof ilvl !== "number" || ilvl <= 0) return null;
  if (ilvl >= 272) return "myth";
  if (ilvl >= 259) return "hero";
  if (ilvl >= 246) return "champion";
  if (ilvl >= 233) return "veteran";
  return "adventurer";
}
