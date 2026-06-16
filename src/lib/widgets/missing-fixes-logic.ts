/**
 * Pure data-shaping for the Missing-enchants/gems widget + its detail lightbox.
 * Kept React-free so it's unit-testable independently of the live snapshot data
 * (which is frequently all-zero when the roster is fully enchanted/gemmed).
 */

export type MissingRow = {
  characterId: string;
  name: string;
  classId: number;
  missingEnchants: number;
  missingGems: number;
  enchSlots: string[];
  gemSlots: string[];
  ilvl: number;
  hasEquip: boolean;
};

/**
 * "Head, Shoulder" / "Ring 1 ×2" — dedupe repeats (e.g. two empty sockets on one
 * item) into a "×N" suffix, preserving first-seen order.
 */
export function formatSlots(slots: string[]): string {
  const counts = new Map<string, number>();
  for (const s of slots) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()]
    .map(([s, n]) => (n > 1 ? `${s} ×${n}` : s))
    .join(", ");
}

/** The minimal fields the deficit math needs (so callers can pass richer rows). */
type Deficit = { missingEnchants: number; missingGems: number };

/** Worst (most missing) first, then by iLvL desc — the widget table order. */
export function sortByWorst(
  a: Deficit & { ilvl: number },
  b: Deficit & { ilvl: number },
): number {
  return (
    b.missingEnchants + b.missingGems - (a.missingEnchants + a.missingGems) ||
    b.ilvl - a.ilvl
  );
}

/**
 * Only the characters with equipment AND at least one unfixed slot — the subject
 * of the detail lightbox. Input is expected pre-sorted (sortByWorst); the filter
 * preserves order so the lightbox matches the table. Generic so it accepts the
 * widget's richer row objects, not just bare MissingRow.
 */
export function selectMissing<T extends Deficit & { hasEquip: boolean }>(
  rows: T[],
): T[] {
  return rows.filter((m) => m.hasEquip && m.missingEnchants + m.missingGems > 0);
}
