import type { WowauditCharacter } from "@/server/ingestion/wowaudit/schemas";

/**
 * Derive the World (Delve) Great Vault row from a WoW Audit character.
 *
 * WoW Audit exposes the nine vault slots as flat columns. WoW's Great Vault
 * is three rows of three in a fixed order — Raid (1-3), Mythic+ (4-6),
 * World/Delves (7-9) — so the World row is `great_vault_slot_7..9`. Each
 * value is the reward item level; 0 / null / "" means the slot is locked.
 *
 * Blizzard's public character API does NOT expose Delve/World vault
 * progress, so this is the only reliable source for the World row.
 */

const WORLD_SLOT_KEYS = [
  "great_vault_slot_7",
  "great_vault_slot_8",
  "great_vault_slot_9",
] as const;

// WoW's World (Delve) vault unlock thresholds — 1/2/3 slots at 2/4/8
// completed Delves. Used only as a fallback when the slot columns are
// absent (older WoW Audit addon snapshots) but `delve_info.total` is set.
const DELVE_SLOT_THRESHOLDS = [2, 4, 8] as const;

const slotIsUnlocked = (v: number | string | null | undefined): boolean => {
  if (v == null) return false;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) && n > 0;
};

export type WorldVault = { unlocked: number; total: 3 };

/**
 * Returns the World vault row, or null when WoW Audit carries no usable
 * signal for this character (so the caller keeps `tracked:false`).
 */
export function extractWorldVault(
  char: WowauditCharacter,
): WorldVault | null {
  const record = char as unknown as Record<string, unknown>;

  const present = WORLD_SLOT_KEYS.filter((k) => k in record);
  if (present.length > 0) {
    const unlocked = WORLD_SLOT_KEYS.reduce(
      (acc, k) =>
        acc + (slotIsUnlocked(record[k] as number | string | null) ? 1 : 0),
      0,
    );
    return { unlocked, total: 3 };
  }

  // Fallback: infer from total Delves completed this period.
  const total = char.delve_info?.total;
  if (typeof total === "number" && total >= 0) {
    const unlocked = DELVE_SLOT_THRESHOLDS.filter((t) => total >= t).length;
    return { unlocked, total: 3 };
  }

  return null;
}

/** Normalize a character name for cross-source matching. */
export const normalizeName = (s: string): string =>
  s.normalize("NFKD").toLowerCase().trim();

/** Normalize a realm (slug or display name) for matching. */
export const normalizeRealm = (s: string): string =>
  s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['\s]/g, "")
    .replace(/-/g, "");
