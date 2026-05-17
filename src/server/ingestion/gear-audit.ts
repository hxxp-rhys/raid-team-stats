/**
 * Gear-audit slot logic — single source of truth for the
 * "missing enchants / gems" check, used by both the Tier-A ingestion
 * (stored counts) and the snapshot router (per-slot detail for hover).
 *
 * WoW MIDNIGHT (12.0) enchantable slots. Validated against live armory
 * data (Mythic raiders) AND Wowhead/Method/Icy-Veins Midnight enchanting
 * guides:
 *   - Midnight ADDED Head and Shoulder enchants.
 *   - Midnight REMOVED Wrist (bracer) and Back (cloak) enchants — they do
 *     not exist this expansion, so checking them produced false "missing"
 *     flags on every character.
 *   - Legs (armor kit / spellthread) reports as an enchantment and is
 *     applied by every raider, so it stays.
 *   - Off-hand is intentionally excluded: `slot.type` can't tell an
 *     enchantable off-hand weapon from a non-enchantable shield / held
 *     item, so flagging it would create false positives.
 */
export const ENCHANTABLE_SLOTS = new Set<string>([
  "HEAD",
  "SHOULDER",
  "CHEST",
  "LEGS",
  "FEET",
  "FINGER_1",
  "FINGER_2",
  "MAIN_HAND",
]);

/** Human-readable slot labels for the hover tooltip. */
export const SLOT_LABEL: Record<string, string> = {
  HEAD: "Head",
  NECK: "Neck",
  SHOULDER: "Shoulder",
  CHEST: "Chest",
  WAIST: "Waist",
  LEGS: "Legs",
  FEET: "Feet",
  WRIST: "Wrist",
  HANDS: "Hands",
  FINGER_1: "Ring 1",
  FINGER_2: "Ring 2",
  TRINKET_1: "Trinket 1",
  TRINKET_2: "Trinket 2",
  BACK: "Back",
  MAIN_HAND: "Weapon",
  OFF_HAND: "Off-hand",
};

const labelFor = (slot: string): string => SLOT_LABEL[slot] ?? slot;

type EquipItem = {
  slot?: { type?: string | null } | null;
  enchantments?: unknown[] | null;
  sockets?: Array<{ item?: unknown }> | null;
};

export type GearAudit = {
  missingEnchantsCount: number;
  missingGemsCount: number;
  /** Readable slot names missing an enchant, e.g. ["Head", "Ring 1"]. */
  missingEnchantSlots: string[];
  /** Readable slot names with an empty socket (one entry per empty socket). */
  missingGemSlots: string[];
};

/**
 * Derive missing-enchant and empty-socket detail from a stored
 * `equipped_items` array (Blizzard shape). Empty sockets are counted on
 * ANY item (rings, neck, head, waist, …), not just enchantable slots.
 */
export function computeGearAudit(
  items: unknown,
): GearAudit {
  const list: EquipItem[] = Array.isArray(items) ? (items as EquipItem[]) : [];
  const missingEnchantSlots: string[] = [];
  const missingGemSlots: string[] = [];

  for (const it of list) {
    const slot = it?.slot?.type ?? undefined;
    if (slot && ENCHANTABLE_SLOTS.has(slot)) {
      const hasEnchant =
        Array.isArray(it.enchantments) && it.enchantments.length > 0;
      if (!hasEnchant) missingEnchantSlots.push(labelFor(slot));
    }
    const sockets = it?.sockets;
    if (Array.isArray(sockets) && sockets.length > 0) {
      const empty = sockets.filter((s) => !s || !s.item).length;
      for (let k = 0; k < empty; k++) {
        missingGemSlots.push(labelFor(slot ?? "?"));
      }
    }
  }

  return {
    missingEnchantsCount: missingEnchantSlots.length,
    missingGemsCount: missingGemSlots.length,
    missingEnchantSlots,
    missingGemSlots,
  };
}
