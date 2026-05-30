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
