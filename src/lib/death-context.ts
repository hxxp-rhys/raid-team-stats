/**
 * Death Context — pure parsing + assembly for the cooldown_usage death
 * lightbox. Given the WCL event window around one death, reconstruct: the
 * incoming-hit timeline (boss damage), which defensives were active at the
 * fatal hit (read off that damage row's `buffs` list), what the player pressed,
 * and the healing they received. Kept free of server imports so vitest pins it.
 *
 * The WCL `buffs` field on a damage row is a "."-delimited list of every buff
 * id active ON THE TARGET at that instant — so "was a defensive up when the
 * killing blow landed" is answered by the fatal row itself.
 */

import { DEFENSIVE_BY_ID, type DefensiveKind } from "@/lib/defensive-cooldowns";

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Parse a WCL `buffs` string ("81256.440290.195181.") into ability ids. */
export function parseBuffString(s: unknown): number[] {
  if (typeof s !== "string" || s.length === 0) return [];
  return s
    .split(".")
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export type RawDamage = {
  ms: number;
  abilityId: number;
  amount: number;
  unmitigated: number;
  mitigated: number;
  absorbed: number;
  overkill: number;
  isAoE: boolean;
  sourceId: number | null;
  buffs: number[];
};

/** Parse `events(dataType: DamageTaken)` rows (enemy→player damage). */
export function parseDamageTakenEvents(raw: unknown): RawDamage[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: RawDamage[] = [];
  for (const e of arr) {
    const o = asRecord(e);
    if (o.type !== "damage") continue;
    const ms = num(o.timestamp);
    const abilityId = num(o.abilityGameID);
    if (ms == null || abilityId == null) continue;
    const amount = num(o.amount) ?? 0;
    out.push({
      ms,
      abilityId,
      amount,
      unmitigated: num(o.unmitigatedAmount) ?? amount,
      mitigated: num(o.mitigated) ?? 0,
      absorbed: num(o.absorbed) ?? 0,
      overkill: num(o.overkill) ?? 0,
      isAoE: o.isAoE === true,
      sourceId: num(o.sourceID),
      buffs: parseBuffString(o.buffs),
    });
  }
  return out;
}

export type RawCast = { ms: number; abilityId: number; landed: boolean };

/** Parse the player's `events(dataType: Casts)` rows in the window. */
export function parseCastWindow(raw: unknown): RawCast[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: RawCast[] = [];
  for (const e of arr) {
    const o = asRecord(e);
    const landed = o.type === "cast";
    if (!landed && o.type !== "begincast") continue;
    const ms = num(o.timestamp);
    const abilityId = num(o.abilityGameID);
    if (ms == null || abilityId == null) continue;
    out.push({ ms, abilityId, landed });
  }
  return out;
}

export type RawHeal = {
  ms: number;
  amount: number;
  absorb: boolean;
  abilityId: number | null;
  sourceId: number | null;
};

/** Parse `events(dataType: Healing)` rows received by the player. */
export function parseHealWindow(raw: unknown): RawHeal[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: RawHeal[] = [];
  for (const e of arr) {
    const o = asRecord(e);
    if (o.type !== "heal" && o.type !== "absorbed") continue;
    const ms = num(o.timestamp);
    if (ms == null) continue;
    out.push({
      ms,
      amount: num(o.amount) ?? 0,
      absorb: o.type === "absorbed",
      abilityId: num(o.abilityGameID),
      // On an absorb event the shield SOURCE is `sourceID`; on a heal it's the
      // healer (`sourceID`).
      sourceId: num(o.sourceID),
    });
  }
  return out;
}

/** Walk the DamageTaken `table` JSON collecting every {guid → name} pair. */
export function parseAbilityNames(tableRaw: unknown): Map<number, string> {
  const map = new Map<number, string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const guid = num(o.guid);
      const name = typeof o.name === "string" ? o.name : null;
      if (guid != null && name) map.set(guid, name);
      for (const val of Object.values(o)) visit(val);
    }
  };
  visit(asRecord(tableRaw).data ?? tableRaw);
  return map;
}

// ── Assembly ────────────────────────────────────────────────────────────────

export type IncomingHit = {
  msBeforeDeath: number;
  abilityId: number;
  abilityName: string | null;
  sourceName: string | null;
  amount: number;
  unmitigated: number;
  absorbed: number;
  overkill: number;
  isAoE: boolean;
  fatal: boolean;
};
export type HealEvent = {
  msBeforeDeath: number;
  abilityName: string | null;
  sourceName: string | null;
  amount: number;
  absorb: boolean;
};
export type DefensiveChip = {
  abilityId: number;
  name: string;
  className: string;
  kind: DefensiveKind;
};
export type CastChip = {
  msBeforeDeath: number;
  abilityId: number;
  name: string;
  kind: DefensiveKind;
  landed: boolean;
};
export type DeathContextResult = {
  windowMs: number;
  fatal: {
    abilityId: number;
    abilityName: string | null;
    sourceName: string | null;
    amount: number;
    overkill: number;
    hadPersonalDefensive: boolean;
  } | null;
  incoming: IncomingHit[];
  activeDefensives: DefensiveChip[];
  defensiveCasts: CastChip[];
  healing: { count: number; total: number; lastMsBefore: number | null };
  healingEvents: HealEvent[];
};

/**
 * Build the structured death context. `deathRelMs` is the death's
 * report-relative timestamp; all event ms are the same basis. `windowMs` is how
 * far back the window reaches (for labelling). `killingAbilityName` (already
 * known from the deaths layer) seeds the fatal-hit name when the table lacks it.
 */
export function buildDeathContext(
  deathRelMs: number,
  damage: RawDamage[],
  casts: RawCast[],
  heals: RawHeal[],
  abilityNames: Map<number, string>,
  opts: {
    windowMs: number;
    killingAbilityId?: number | null;
    killingAbilityName?: string | null;
    actorNames?: Map<number, string>;
  },
): DeathContextResult {
  const nameOf = (id: number): string | null => abilityNames.get(id) ?? null;
  const actorOf = (id: number | null): string | null =>
    id != null ? (opts.actorNames?.get(id) ?? null) : null;

  // Incoming hits at/before the death (a tiny grace for same-ms ordering).
  const hits = damage
    .filter((d) => d.ms <= deathRelMs + 250)
    .sort((a, b) => a.ms - b.ms);

  // Fatal hit: prefer an overkill hit nearest the death, else the last hit, and
  // prefer one matching the known killing ability id.
  let fatalIdx = -1;
  for (let i = hits.length - 1; i >= 0; i--) {
    if (hits[i]!.overkill > 0) {
      fatalIdx = i;
      break;
    }
  }
  if (fatalIdx === -1 && opts.killingAbilityId != null) {
    for (let i = hits.length - 1; i >= 0; i--) {
      if (hits[i]!.abilityId === opts.killingAbilityId) {
        fatalIdx = i;
        break;
      }
    }
  }
  // Many deaths have no overkill flag and no known killing ability (the deaths
  // layer didn't capture it). The trailing rows near death are often fully
  // absorbed / immune 0-damage ticks, so fall back to the LAST hit that actually
  // dealt damage — that is the killing blow — before the absolute-last row.
  if (fatalIdx === -1) {
    for (let i = hits.length - 1; i >= 0; i--) {
      if (hits[i]!.amount > 0) {
        fatalIdx = i;
        break;
      }
    }
  }
  if (fatalIdx === -1 && hits.length > 0) fatalIdx = hits.length - 1;

  const fatalRow = fatalIdx >= 0 ? hits[fatalIdx]! : null;

  // Active defensives = the allowlisted buffs present on the fatal row.
  const activeIds = fatalRow ? fatalRow.buffs : [];
  const activeDefensives: DefensiveChip[] = [];
  for (const id of activeIds) {
    const def = DEFENSIVE_BY_ID.get(id);
    if (def) {
      activeDefensives.push({
        abilityId: id,
        name: def.name,
        className: def.className,
        kind: def.kind,
      });
    }
  }
  const hadPersonalDefensive = activeDefensives.some((d) => d.kind === "personal");

  const incoming: IncomingHit[] = hits.map((d, i) => ({
    msBeforeDeath: Math.max(0, Math.round(deathRelMs - d.ms)),
    abilityId: d.abilityId,
    abilityName:
      nameOf(d.abilityId) ??
      (opts.killingAbilityId === d.abilityId ? opts.killingAbilityName ?? null : null),
    sourceName: actorOf(d.sourceId),
    amount: d.amount,
    unmitigated: d.unmitigated,
    absorbed: d.absorbed,
    overkill: d.overkill,
    isAoE: d.isAoE,
    fatal: i === fatalIdx,
  }));

  // The player's defensive casts in the window (allowlisted only).
  const defensiveCasts: CastChip[] = [];
  for (const c of casts) {
    const def = DEFENSIVE_BY_ID.get(c.abilityId);
    if (!def || c.ms > deathRelMs + 250) continue;
    defensiveCasts.push({
      msBeforeDeath: Math.max(0, Math.round(deathRelMs - c.ms)),
      abilityId: c.abilityId,
      name: def.name,
      kind: def.kind,
      landed: c.landed,
    });
  }
  defensiveCasts.sort((a, b) => a.msBeforeDeath - b.msBeforeDeath);

  const inWindowHeals = heals.filter((h) => h.ms <= deathRelMs + 250);
  const healing = {
    count: inWindowHeals.length,
    total: inWindowHeals.reduce((s, h) => s + h.amount, 0),
    lastMsBefore:
      inWindowHeals.length > 0
        ? Math.max(
            0,
            Math.round(
              deathRelMs - Math.max(...inWindowHeals.map((h) => h.ms)),
            ),
          )
        : null,
  };
  // The biggest heals/absorbs that landed in the window (named), newest first —
  // shown alongside the damage so a leader can see the healing race.
  const healingEvents: HealEvent[] = inWindowHeals
    .filter((h) => h.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8)
    .map((h) => ({
      msBeforeDeath: Math.max(0, Math.round(deathRelMs - h.ms)),
      abilityName: h.abilityId != null ? nameOf(h.abilityId) : null,
      sourceName: actorOf(h.sourceId),
      amount: h.amount,
      absorb: h.absorb,
    }))
    .sort((a, b) => a.msBeforeDeath - b.msBeforeDeath);

  return {
    windowMs: opts.windowMs,
    fatal: fatalRow
      ? {
          abilityId: fatalRow.abilityId,
          abilityName:
            nameOf(fatalRow.abilityId) ?? opts.killingAbilityName ?? null,
          sourceName: actorOf(fatalRow.sourceId),
          amount: fatalRow.amount,
          overkill: fatalRow.overkill,
          hadPersonalDefensive,
        }
      : null,
    incoming,
    activeDefensives,
    defensiveCasts,
    healing,
    healingEvents,
  };
}
