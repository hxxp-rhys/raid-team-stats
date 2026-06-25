/**
 * Personal-defensive ability allowlist for the cooldown_usage widget.
 *
 * STATIC, PATCH-COUPLED DATA. Spell **ids** are stable across patches but
 * cooldown **durations** drift with talent reworks — re-verify the durations on
 * each content patch. This table is registered in the `wow-patch-upgrade`
 * skill (§4 — Ability ids) as a per-patch reference. Baseline values are WoW
 * Midnight 12.0.7, re-verified 2026-06-25 against the live client DB2 (WTL —
 * SpellCooldowns / SpellCategory charge path) AND Warcraft Wiki / Wowhead /
 * Icy-Veins. NOTE: `cooldownSec` is reference/display metadata only — no app
 * logic reads it (the cooldown_usage / death-context analytics count observed
 * WCL buff & cast windows, not these numbers).
 *
 * Corrections 2026-06-25 (prior values were stale — mostly pre-Midnight):
 *   Shield Wall 240→180 (cut in 11.1.0), Icebound Fortitude 180→120,
 *   Guardian of Ancient Kings 300→180 (12.0.0), Metamorphosis (Veng) 180→120
 *   (12.0.0), Astral Shift 90→120, Survival of the Fittest 180→90 (DB2-
 *   authoritative; web prose conflicts — re-check next patch). Two abilities
 *   were REWORKED in 12.0.0 and no longer carry a standalone cooldown — see the
 *   inline NOTEs on Shield of Vengeance (184662) and Netherwalk (196555).
 *
 * `kind`:
 *  - "personal" — a self-cast survival CD; the widget's headline filter uses
 *    these (and only counts a buff window where sourceID === targetID).
 *  - "external" — cast on OTHER players (Pain Suppression, Ironbark, …). Kept
 *    so a later enrichment can credit who externalised a save onto a dying
 *    player; EXCLUDED from the "did THEY have a personal defensive" headline.
 *  - "raid" — raid-wide mitigation (Darkness); informational, excluded from the
 *    personal headline.
 */

export type DefensiveKind = "personal" | "external" | "raid";

export interface DefensiveAbility {
  id: number;
  name: string;
  /** Class (and spec where the CD is spec-specific) for display/grouping. */
  className: string;
  /** Baseline cooldown in seconds (12.0.7; talent-reduced in many cases). */
  cooldownSec: number;
  kind: DefensiveKind;
}

export const DEFENSIVE_ABILITIES: readonly DefensiveAbility[] = [
  // Warrior
  { id: 871, name: "Shield Wall", className: "Warrior (Prot)", cooldownSec: 180, kind: "personal" },
  { id: 12975, name: "Last Stand", className: "Warrior (Prot)", cooldownSec: 180, kind: "personal" },
  { id: 184364, name: "Enraged Regeneration", className: "Warrior (Fury)", cooldownSec: 120, kind: "personal" },
  // Druid
  { id: 22812, name: "Barkskin", className: "Druid", cooldownSec: 60, kind: "personal" },
  { id: 61336, name: "Survival Instincts", className: "Druid (Guardian/Feral)", cooldownSec: 180, kind: "personal" },
  { id: 102342, name: "Ironbark", className: "Druid (Resto)", cooldownSec: 90, kind: "external" },
  // Priest
  { id: 47585, name: "Dispersion", className: "Priest (Shadow)", cooldownSec: 120, kind: "personal" },
  { id: 19236, name: "Desperate Prayer", className: "Priest", cooldownSec: 90, kind: "personal" },
  { id: 33206, name: "Pain Suppression", className: "Priest (Disc)", cooldownSec: 180, kind: "external" },
  { id: 47788, name: "Guardian Spirit", className: "Priest (Holy)", cooldownSec: 180, kind: "external" },
  // Death Knight
  { id: 48792, name: "Icebound Fortitude", className: "Death Knight", cooldownSec: 120, kind: "personal" },
  { id: 48707, name: "Anti-Magic Shell", className: "Death Knight", cooldownSec: 60, kind: "personal" },
  { id: 49028, name: "Dancing Rune Weapon", className: "Death Knight (Blood)", cooldownSec: 120, kind: "personal" },
  { id: 55233, name: "Vampiric Blood", className: "Death Knight (Blood)", cooldownSec: 90, kind: "personal" },
  // Paladin
  { id: 642, name: "Divine Shield", className: "Paladin", cooldownSec: 300, kind: "personal" },
  { id: 498, name: "Divine Protection", className: "Paladin", cooldownSec: 60, kind: "personal" },
  { id: 86659, name: "Guardian of Ancient Kings", className: "Paladin (Prot)", cooldownSec: 180, kind: "personal" },
  // NOTE 12.0.7: reworked in 12.0.0 — Shield of Vengeance is now an absorb cast BY
  // Divine Protection (498); it has NO standalone cooldown. Still a valid buff id in
  // logs, so kept in the allowlist; cooldownSec below is legacy — review whether to re-id.
  { id: 184662, name: "Shield of Vengeance", className: "Paladin (Ret)", cooldownSec: 120, kind: "personal" },
  // Rogue
  { id: 31224, name: "Cloak of Shadows", className: "Rogue", cooldownSec: 120, kind: "personal" },
  { id: 5277, name: "Evasion", className: "Rogue", cooldownSec: 120, kind: "personal" },
  { id: 1966, name: "Feint", className: "Rogue", cooldownSec: 15, kind: "personal" },
  // Hunter
  { id: 186265, name: "Aspect of the Turtle", className: "Hunter", cooldownSec: 180, kind: "personal" },
  { id: 264735, name: "Survival of the Fittest", className: "Hunter", cooldownSec: 90, kind: "personal" }, // 12.0.7: 90s per client DB2 (web prose says 180; DB2-authoritative — re-check next patch)
  // Monk
  { id: 115203, name: "Fortifying Brew", className: "Monk", cooldownSec: 360, kind: "personal" },
  { id: 122470, name: "Touch of Karma", className: "Monk (WW)", cooldownSec: 90, kind: "personal" },
  { id: 122783, name: "Diffuse Magic", className: "Monk", cooldownSec: 90, kind: "personal" },
  { id: 116849, name: "Life Cocoon", className: "Monk (MW)", cooldownSec: 120, kind: "external" },
  // Demon Hunter
  // NOTE 12.0.7: the standalone 180s Netherwalk active was REMOVED in 12.0.0; 196555 is
  // now a passive augmenting Blur (198589, already tracked). No standalone cooldown —
  // cooldownSec below is legacy; review whether to drop this id from the allowlist.
  { id: 196555, name: "Netherwalk", className: "Demon Hunter (Havoc)", cooldownSec: 180, kind: "personal" },
  { id: 187827, name: "Metamorphosis", className: "Demon Hunter (Veng)", cooldownSec: 120, kind: "personal" },
  { id: 198589, name: "Blur", className: "Demon Hunter (Havoc)", cooldownSec: 60, kind: "personal" },
  { id: 196718, name: "Darkness", className: "Demon Hunter", cooldownSec: 300, kind: "raid" },
  // Warlock
  { id: 104773, name: "Unending Resolve", className: "Warlock", cooldownSec: 180, kind: "personal" },
  { id: 108416, name: "Dark Pact", className: "Warlock", cooldownSec: 60, kind: "personal" },
  // Shaman
  { id: 108271, name: "Astral Shift", className: "Shaman", cooldownSec: 120, kind: "personal" },
  // Mage
  { id: 45438, name: "Ice Block", className: "Mage", cooldownSec: 240, kind: "personal" },
  { id: 342245, name: "Alter Time", className: "Mage", cooldownSec: 60, kind: "personal" },
] as const;

/** id → ability, for O(1) lookup by spell id. */
export const DEFENSIVE_BY_ID: ReadonlyMap<number, DefensiveAbility> = new Map(
  DEFENSIVE_ABILITIES.map((d) => [d.id, d]),
);

/** Every allowlisted defensive id (buffs + casts filter). */
export const ALL_DEFENSIVE_IDS: readonly number[] = DEFENSIVE_ABILITIES.map(
  (d) => d.id,
);

/**
 * Personal-defensive ids only — the set the "did the player have THEIR OWN
 * defensive up" headline counts. Externals/raid CDs are fetched (for later
 * enrichment) but not counted here.
 */
export const PERSONAL_DEFENSIVE_IDS: ReadonlySet<number> = new Set(
  DEFENSIVE_ABILITIES.filter((d) => d.kind === "personal").map((d) => d.id),
);

/** WCL filterExpression for the Buffs query (all allowlisted ids, no type). */
export const DEFENSIVE_BUFFS_FILTER = `ability.id in (${ALL_DEFENSIVE_IDS.join(", ")})`;

/** WCL filterExpression for the Casts query (landed casts only). */
export const DEFENSIVE_CASTS_FILTER = `type = "cast" and ability.id in (${ALL_DEFENSIVE_IDS.join(", ")})`;

/** Display name for a defensive id (falls back to the raw id). */
export function defensiveName(id: number | null | undefined): string | null {
  if (id == null) return null;
  return DEFENSIVE_BY_ID.get(id)?.name ?? `Ability ${id}`;
}
