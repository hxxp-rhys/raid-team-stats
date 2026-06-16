/**
 * Cooldown-Usage — pure computation for the `cooldown_usage` widget.
 *
 * Log-derived: for each death we already store (WclFightDeath), did the dying
 * player have a PERSONAL defensive cooldown ACTIVE at the moment of death, and
 * when did they last self-cast one this pull? Two cheap signals from WCL
 * `events(dataType: Buffs)` + `events(dataType: Casts)`, both filtered to the
 * defensive allowlist (src/lib/defensive-cooldowns.ts):
 *   1. defensive ACTIVE at death — reliable: the most-recent buff event for the
 *      (fight, target, ability) at or before the death is an apply/refresh, not
 *      a remove → it was up.
 *   2. last defensive CAST before death — the "pressed a button recently?"
 *      secondary signal; the READ layer thresholds msBefore.
 * "Available-but-unused" (needs static cooldown durations + cast history) is a
 * v1.1 follow-up and intentionally NOT computed here.
 *
 * Kept free of server imports so vitest pins it, exactly like
 * first-death-ledger.ts. Everything works in REPORT-RELATIVE ms (the WCL event
 * basis); the GRS converts a persisted death's absolute `deathAt` back to
 * report-relative via `deathAt.getTime() - reportStartMs` before calling in.
 */

import {
  PERSONAL_DEFENSIVE_IDS,
  defensiveName,
} from "@/lib/defensive-cooldowns";

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// ── INGEST: parse ─────────────────────────────────────────────────────────

/** One buff transition from `events(dataType: Buffs)`. */
export type ParsedBuffEvent = {
  /** "on" = applybuff/refreshbuff, "off" = removebuff. */
  state: "on" | "off";
  sourceActorId: number | null; // caster (null = WCL sentinel)
  targetActorId: number; // who the buff is ON
  abilityGameId: number;
  timestamp: number; // report-relative ms
  fightId: number;
};

/** Parse the buffs `events.data` JSON scalar. Tolerant; never throws. */
export function parseBuffEvents(raw: unknown): ParsedBuffEvent[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: ParsedBuffEvent[] = [];
  for (const e of arr) {
    const o = asRecord(e);
    const t = o.type;
    const state =
      t === "applybuff" || t === "refreshbuff"
        ? "on"
        : t === "removebuff"
          ? "off"
          : null;
    if (state == null) continue;
    const fightId = numOrNull(o.fight);
    const targetActorId = numOrNull(o.targetID);
    const abilityGameId = numOrNull(o.abilityGameID);
    const timestamp = numOrNull(o.timestamp);
    if (
      fightId == null ||
      targetActorId == null ||
      abilityGameId == null ||
      timestamp == null
    )
      continue;
    const src = numOrNull(o.sourceID);
    out.push({
      state,
      sourceActorId: src != null && src > 0 ? src : null,
      targetActorId,
      abilityGameId,
      timestamp,
      fightId,
    });
  }
  return out;
}

/** One landed defensive cast from `events(dataType: Casts)`. */
export type ParsedDefensiveCast = {
  sourceActorId: number; // who cast it
  abilityGameId: number;
  timestamp: number; // report-relative ms
  fightId: number;
};

/** Parse the casts `events.data` JSON scalar. Only `type:"cast"` (landed). */
export function parseDefensiveCasts(raw: unknown): ParsedDefensiveCast[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: ParsedDefensiveCast[] = [];
  for (const e of arr) {
    const o = asRecord(e);
    if (o.type !== "cast") continue;
    const fightId = numOrNull(o.fight);
    const sourceActorId = numOrNull(o.sourceID);
    const abilityGameId = numOrNull(o.abilityGameID);
    const timestamp = numOrNull(o.timestamp);
    if (
      fightId == null ||
      sourceActorId == null ||
      sourceActorId <= 0 ||
      abilityGameId == null ||
      timestamp == null
    )
      continue;
    out.push({ sourceActorId, abilityGameId, timestamp, fightId });
  }
  return out;
}

// ── COMPUTE: per-death cooldown usage ─────────────────────────────────────

/** A death the cooldown pass evaluates (report-relative ms). */
export type DeathForCooldown = {
  fightId: number;
  targetActorId: number;
  relMs: number; // report-relative ms of the death
};

/** The cooldown-usage layer for one death (stamped onto WclFightDeath). */
export type CooldownUsageResult = {
  defensiveActiveGameId: number | null;
  defensiveActiveName: string | null;
  lastDefensiveCastId: number | null;
  lastDefensiveCastMsBefore: number | null;
};

const groupKey = (fightId: number, targetActorId: number, ability: number) =>
  `${fightId}|${targetActorId}|${ability}`;

/**
 * Compute the cooldown-usage layer for each death. Returns results
 * INDEX-ALIGNED with `deaths` (so the caller can zip them back onto the
 * persisted rows by position).
 *
 * - defensive ACTIVE: among PERSONAL defensive buffs ON the dying player
 *   (sourceID === targetID, self-applied) in that fight, the buff is "active at
 *   death" iff the most-recent transition at or before the death is an "on".
 *   When several are active, the most-recently-applied one is reported.
 * - last CAST: the dying player's most-recent PERSONAL defensive self-cast at
 *   or before the death this pull; msBefore = death − cast.
 */
export function computeCooldownUsage(
  deaths: DeathForCooldown[],
  buffs: ParsedBuffEvent[],
  casts: ParsedDefensiveCast[],
): CooldownUsageResult[] {
  // Personal, self-applied buff transitions, grouped + time-sorted.
  const buffGroups = new Map<string, ParsedBuffEvent[]>();
  for (const b of buffs) {
    if (!PERSONAL_DEFENSIVE_IDS.has(b.abilityGameId)) continue;
    // self-applied only (externals are excluded by ability id already, this is
    // belt-and-suspenders for any odd source attribution)
    if (b.sourceActorId != null && b.sourceActorId !== b.targetActorId) continue;
    const k = groupKey(b.fightId, b.targetActorId, b.abilityGameId);
    const list = buffGroups.get(k);
    if (list) list.push(b);
    else buffGroups.set(k, [b]);
  }
  for (const list of buffGroups.values())
    list.sort((a, b) => a.timestamp - b.timestamp);

  // Personal casts grouped by (fight, caster), time-sorted.
  const castGroups = new Map<string, ParsedDefensiveCast[]>();
  for (const c of casts) {
    if (!PERSONAL_DEFENSIVE_IDS.has(c.abilityGameId)) continue;
    const k = `${c.fightId}|${c.sourceActorId}`;
    const list = castGroups.get(k);
    if (list) list.push(c);
    else castGroups.set(k, [c]);
  }
  for (const list of castGroups.values())
    list.sort((a, b) => a.timestamp - b.timestamp);

  // The distinct personal ability ids any (fight,target) used, for the active
  // scan (avoids scanning all 30+ ids per death).
  const abilitiesByTarget = new Map<string, Set<number>>();
  for (const k of buffGroups.keys()) {
    const [fightId, target, ability] = k.split("|");
    const tk = `${fightId}|${target}`;
    const set = abilitiesByTarget.get(tk);
    if (set) set.add(Number(ability));
    else abilitiesByTarget.set(tk, new Set([Number(ability)]));
  }

  return deaths.map((d) => {
    // (1) defensive active at death — the most-recently-applied active one.
    let activeId: number | null = null;
    let activeOnAt = -Infinity;
    const ids = abilitiesByTarget.get(`${d.fightId}|${d.targetActorId}`);
    if (ids) {
      for (const ability of ids) {
        const events = buffGroups.get(
          groupKey(d.fightId, d.targetActorId, ability),
        );
        if (!events) continue;
        // last transition at or before the death
        let last: ParsedBuffEvent | null = null;
        for (const e of events) {
          if (e.timestamp <= d.relMs) last = e;
          else break;
        }
        if (last && last.state === "on" && last.timestamp > activeOnAt) {
          activeOnAt = last.timestamp;
          activeId = ability;
        }
      }
    }

    // (2) most-recent personal self-cast at or before the death this pull.
    let lastCastId: number | null = null;
    let lastCastMsBefore: number | null = null;
    const myCasts = castGroups.get(`${d.fightId}|${d.targetActorId}`);
    if (myCasts) {
      for (const c of myCasts) {
        if (c.timestamp <= d.relMs) {
          lastCastId = c.abilityGameId;
          lastCastMsBefore = d.relMs - c.timestamp;
        } else break;
      }
    }

    return {
      defensiveActiveGameId: activeId,
      defensiveActiveName: defensiveName(activeId),
      lastDefensiveCastId: lastCastId,
      lastDefensiveCastMsBefore: lastCastMsBefore,
    };
  });
}

// ── READ: aggregate stored cooldown layer into coaching stats ─────────────

/** A stored death row the read aggregates over. */
export type CooldownDeathInput = {
  encounterId: number;
  difficulty: number;
  kill: boolean;
  characterId: string | null;
  killingAbilityGameId: number | null;
  killingAbilityName: string | null;
  defensiveActiveGameId: number | null;
  lastDefensiveCastMsBefore: number | null;
  /** true once the cooldown layer has been computed for this row. */
  computed: boolean;
};

export type CooldownPlayerStat = {
  characterId: string;
  deaths: number; // computed wipe deaths
  covered: number; // a personal defensive was active at death
  uncovered: number;
  /** uncovered deaths where they DID cast a defensive shortly before (pressed
   *  late / it didn't cover) — distinguishes "too late" from "did nothing". */
  pressedLate: number;
  coveragePct: number;
};

export type CooldownMechanicStat = {
  gameId: number | null;
  name: string | null;
  deaths: number;
  uncovered: number;
};

export type CooldownDifficultyAgg = {
  difficulty: number;
  deaths: number;
  covered: number;
  uncovered: number;
  coveragePct: number;
  players: CooldownPlayerStat[];
  mechanics: CooldownMechanicStat[];
};

/** A defensive cast within this many ms before a death counts as "pressed". */
export const RECENT_CAST_MS = 5000;

/**
 * Aggregate the stored cooldown layer into per-difficulty coaching stats:
 * overall coverage (share of deaths with a personal defensive active), a
 * per-player table (who isn't mitigating the hits that kill them), and a
 * per-mechanic table (which abilities the team eats raw). WIPE deaths only
 * (kill === false) and only rows whose cooldown layer is computed.
 */
export function aggregateCooldownUsage(
  deaths: CooldownDeathInput[],
  opts?: { recentCastMs?: number },
): CooldownDifficultyAgg[] {
  const recentMs = opts?.recentCastMs ?? RECENT_CAST_MS;
  // difficulty → accumulator
  const byDiff = new Map<
    number,
    {
      deaths: number;
      covered: number;
      uncovered: number;
      players: Map<string, CooldownPlayerStat>;
      mechanics: Map<string, CooldownMechanicStat>;
    }
  >();

  for (const d of deaths) {
    if (d.kill || !d.computed) continue;
    let acc = byDiff.get(d.difficulty);
    if (!acc) {
      acc = {
        deaths: 0,
        covered: 0,
        uncovered: 0,
        players: new Map(),
        mechanics: new Map(),
      };
      byDiff.set(d.difficulty, acc);
    }
    const isCovered = d.defensiveActiveGameId != null;
    acc.deaths++;
    if (isCovered) acc.covered++;
    else acc.uncovered++;

    // per-player (roster only)
    if (d.characterId) {
      let p = acc.players.get(d.characterId);
      if (!p) {
        p = {
          characterId: d.characterId,
          deaths: 0,
          covered: 0,
          uncovered: 0,
          pressedLate: 0,
          coveragePct: 0,
        };
        acc.players.set(d.characterId, p);
      }
      p.deaths++;
      if (isCovered) p.covered++;
      else {
        p.uncovered++;
        if (
          d.lastDefensiveCastMsBefore != null &&
          d.lastDefensiveCastMsBefore <= recentMs
        )
          p.pressedLate++;
      }
    }

    // per-mechanic (killing ability)
    const mk = d.killingAbilityGameId != null ? String(d.killingAbilityGameId) : "?";
    let m = acc.mechanics.get(mk);
    if (!m) {
      m = {
        gameId: d.killingAbilityGameId,
        name: d.killingAbilityName,
        deaths: 0,
        uncovered: 0,
      };
      acc.mechanics.set(mk, m);
    }
    m.deaths++;
    if (!isCovered) m.uncovered++;
    if (m.name == null && d.killingAbilityName != null) m.name = d.killingAbilityName;
  }

  const out: CooldownDifficultyAgg[] = [];
  for (const [difficulty, acc] of byDiff) {
    const players = [...acc.players.values()]
      .map((p) => ({
        ...p,
        coveragePct: p.deaths > 0 ? (p.covered / p.deaths) * 100 : 0,
      }))
      .sort((a, b) => b.uncovered - a.uncovered || b.deaths - a.deaths);
    const mechanics = [...acc.mechanics.values()].sort(
      (a, b) => b.uncovered - a.uncovered || b.deaths - a.deaths,
    );
    out.push({
      difficulty,
      deaths: acc.deaths,
      covered: acc.covered,
      uncovered: acc.uncovered,
      coveragePct: acc.deaths > 0 ? (acc.covered / acc.deaths) * 100 : 0,
      players,
      mechanics,
    });
  }
  return out.sort((a, b) => b.difficulty - a.difficulty);
}
