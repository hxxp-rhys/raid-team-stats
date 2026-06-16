/**
 * First-Death Ledger — pure computation for the `first_death_ledger` widget.
 *
 * Two halves, both kept free of server imports so vitest pins them:
 *   1. INGEST side — parse the WCL `events(dataType: Deaths)` JSON spine and
 *      the `table(dataType: Deaths)` overkill drill-down, merge them, and
 *      assign each death its ORDER within its pull (0 = first to die).
 *   2. READ side — aggregate stored deaths + fights into per-(encounter,
 *      difficulty) per-character rates: first-death rate, early-death rate,
 *      deaths/pull, top killing ability, death-time histogram.
 *
 * Design rules straight from the research (W2):
 *   - "Who died first is almost always the most important death" — lead with
 *     death ORDER; killing-blow attribution lies (tiny ticking DoTs), so the
 *     ability/overkill are context, never the headline.
 *   - Rates are per PULLS-PRESENT (the pull's friendlyPlayers), never roster.
 *   - first-death = order 0; early-death = order ≤ 2.
 *   - Kill-pull deaths are kept separate from wipe (progression) deaths.
 *   - Encounters with < MIN_WIPES wipe pulls and members present for
 *     < MIN_PULLS_PRESENT wipes are hidden (too few samples to be fair).
 */

// ── INGEST: parse + order ────────────────────────────────────────────────

/** One death from `events(dataType: Deaths)`. */
export type ParsedDeathEvent = {
  fightId: number;
  targetActorId: number; // report-local actor id of who died
  killerActorId: number | null;
  killingAbilityGameId: number | null;
  timestamp: number; // report-relative ms
};

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Parse the `events.data` JSON scalar into death events. Tolerant: anything
 * missing a fight/target/timestamp is dropped, never throws. `abilityGameID`
 * is 0 on death rows — the real killer is `killerID` + `killingAbilityGameID`.
 */
export function parseDeathEvents(raw: unknown): ParsedDeathEvent[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: ParsedDeathEvent[] = [];
  for (const e of arr) {
    const o = asRecord(e);
    if (o.type !== "death") continue;
    const fightId = numOrNull(o.fight);
    const targetActorId = numOrNull(o.targetID);
    const timestamp = numOrNull(o.timestamp);
    if (fightId == null || targetActorId == null || timestamp == null) continue;
    const killer = numOrNull(o.killerID);
    out.push({
      fightId,
      targetActorId,
      // -1 / 0 are WCL's "environment / none" sentinels — treat as no killer.
      killerActorId: killer != null && killer > 0 ? killer : null,
      killingAbilityGameId: numOrNull(o.killingAbilityGameID),
      timestamp,
    });
  }
  return out;
}

/** One row from `table(dataType: Deaths)` — the overkill/ability drill-down. */
export type ParsedDeathTableEntry = {
  fightId: number;
  actorId: number;
  timestamp: number;
  overkill: number | null;
  killingAbilityName: string | null;
  killingAbilityGameId: number | null;
};

/** Parse the deaths `table` JSON scalar (`{ data: { entries: [...] } }`). */
export function parseDeathsTable(raw: unknown): ParsedDeathTableEntry[] {
  const entries = asRecord(asRecord(raw).data).entries;
  const arr = Array.isArray(entries) ? entries : [];
  const out: ParsedDeathTableEntry[] = [];
  for (const e of arr) {
    const o = asRecord(e);
    const fightId = numOrNull(o.fight);
    const actorId = numOrNull(o.id);
    const timestamp = numOrNull(o.timestamp);
    if (fightId == null || actorId == null || timestamp == null) continue;
    const kb = asRecord(o.killingBlow);
    const name = typeof kb.name === "string" ? kb.name : null;
    out.push({
      fightId,
      actorId,
      timestamp,
      overkill: numOrNull(o.overkill),
      killingAbilityName: name,
      killingAbilityGameId: numOrNull(kb.guid),
    });
  }
  return out;
}

/** A merged, order-assigned death ready to persist. */
export type IngestDeath = {
  fightId: number;
  targetActorId: number;
  killerActorId: number | null;
  killingAbilityGameId: number | null;
  killingAbilityName: string | null;
  timestamp: number; // report-relative ms
  overkill: number | null;
  /** 0-based index within the pull, by ascending timestamp. */
  deathOrder: number;
};

/** Match tolerance between an event's death time and the table row's. */
const MERGE_TOLERANCE_MS = 3000;

/**
 * Merge the events spine with the table drill-down and assign per-pull death
 * order. Events are the authoritative spine (ordered, with the killer actor);
 * the table contributes overkill + the killing-ability NAME, matched per
 * (fight, actor) by nearest timestamp (a player can die more than once per
 * pull via battle-rez, so each event greedily claims the closest unused row).
 */
export function buildIngestDeaths(
  events: ParsedDeathEvent[],
  table: ParsedDeathTableEntry[],
): IngestDeath[] {
  // Index table rows by fight|actor for nearest-timestamp matching.
  const tableByKey = new Map<string, ParsedDeathTableEntry[]>();
  for (const t of table) {
    const key = `${t.fightId}|${t.actorId}`;
    (tableByKey.get(key) ?? tableByKey.set(key, []).get(key)!).push(t);
  }
  const used = new Set<ParsedDeathTableEntry>();

  // Group events by fight, order by timestamp.
  const byFight = new Map<number, ParsedDeathEvent[]>();
  for (const e of events) {
    (byFight.get(e.fightId) ?? byFight.set(e.fightId, []).get(e.fightId)!).push(
      e,
    );
  }
  const out: IngestDeath[] = [];
  for (const [, evs] of byFight) {
    evs.sort((a, b) => a.timestamp - b.timestamp);
    evs.forEach((e, order) => {
      // Nearest unused table row for this (fight, actor) within tolerance.
      const cands = tableByKey.get(`${e.fightId}|${e.targetActorId}`) ?? [];
      let best: ParsedDeathTableEntry | null = null;
      let bestDelta = MERGE_TOLERANCE_MS + 1;
      for (const t of cands) {
        if (used.has(t)) continue;
        const d = Math.abs(t.timestamp - e.timestamp);
        if (d < bestDelta) {
          best = t;
          bestDelta = d;
        }
      }
      if (best) used.add(best);
      out.push({
        fightId: e.fightId,
        targetActorId: e.targetActorId,
        killerActorId: e.killerActorId,
        killingAbilityGameId:
          e.killingAbilityGameId ?? best?.killingAbilityGameId ?? null,
        killingAbilityName: best?.killingAbilityName ?? null,
        timestamp: e.timestamp,
        overkill: best?.overkill ?? null,
        deathOrder: order,
      });
    });
  }
  return out;
}

// ── BREZ: parse combat-rez casts + match to deaths ────────────────────────

/** One combat-resurrection cast from `events(dataType: Casts)`. */
export type ParsedRezCast = {
  fightId: number;
  targetActorId: number; // who got rezzed
  rezzerActorId: number | null; // who cast it
  abilityGameId: number | null; // which rez spell
  timestamp: number; // report-relative ms
};

/**
 * Parse the rez-casts `events.data`. Only `type === "cast"` (the LANDED rez —
 * begincasts can be cancelled). Tolerant; never throws.
 */
export function parseRezCasts(raw: unknown): ParsedRezCast[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: ParsedRezCast[] = [];
  for (const e of arr) {
    const o = asRecord(e);
    if (o.type !== "cast") continue;
    const fightId = numOrNull(o.fight);
    const targetActorId = numOrNull(o.targetID);
    const timestamp = numOrNull(o.timestamp);
    if (fightId == null || targetActorId == null || timestamp == null) continue;
    const rezzer = numOrNull(o.sourceID);
    out.push({
      fightId,
      targetActorId,
      rezzerActorId: rezzer != null && rezzer > 0 ? rezzer : null,
      abilityGameId: numOrNull(o.abilityGameID),
      timestamp,
    });
  }
  return out;
}

/** A death row the rez matcher can stamp (absolute death time in ms). */
export type RezTarget = {
  fightId: number;
  targetActorId: number;
  deathAtMs: number;
  rezzedAtMs: number | null;
  rezzerActorId: number | null;
  rezAbilityGameId: number | null;
};

/**
 * Assign each rez (absolute ms) to the most-recent PRIOR unmatched death of
 * the same target in the same pull — the death it brought back. Mutates the
 * death rows in place. A rez with no matching prior death (or whose target
 * never re-dies) leaves that death's rez fields null; the surplus of casts
 * over re-deaths IS the successful-rez signal, computed at read time.
 */
export function matchRezzesToDeaths(
  deaths: RezTarget[],
  rezzes: Array<{
    fightId: number;
    targetActorId: number;
    absTimeMs: number;
    rezzerActorId: number | null;
    abilityGameId: number | null;
  }>,
): void {
  const byKey = new Map<string, RezTarget[]>();
  for (const d of deaths) {
    const k = `${d.fightId}|${d.targetActorId}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(d);
  }
  for (const r of [...rezzes].sort((a, b) => a.absTimeMs - b.absTimeMs)) {
    const ds = byKey.get(`${r.fightId}|${r.targetActorId}`);
    if (!ds) continue;
    let best: RezTarget | null = null;
    for (const d of ds) {
      if (d.deathAtMs <= r.absTimeMs && d.rezzedAtMs == null) {
        if (!best || d.deathAtMs > best.deathAtMs) best = d;
      }
    }
    if (best) {
      best.rezzedAtMs = r.absTimeMs;
      best.rezzerActorId = r.rezzerActorId;
      best.rezAbilityGameId = r.abilityGameId;
    }
  }
}

// ── READ: aggregate into per-encounter, per-character rates ───────────────

export type LedgerFight = {
  encounterId: number;
  difficulty: number;
  kill: boolean;
  /** Resolved character ids present in this pull (from friendlyPlayers). */
  presentCharacterIds: string[];
  /**
   * Whether this pull's deaths were actually fetched (its report has a death
   * layer). Only OBSERVED wipes count toward rate denominators — a pull we
   * have no death data for can't tell us whether anyone died first, so
   * counting it would silently understate every rate while a backfill is
   * still in flight.
   */
  observed: boolean;
};

export type LedgerDeath = {
  encounterId: number;
  difficulty: number;
  kill: boolean;
  /** null = unmatched actor (counted in pull totals, not per-character rates). */
  characterId: string | null;
  deathOrder: number;
  /** ms into the pull (deathAt − pull start) — for the histogram. */
  msIntoPull: number;
  killingAbilityName: string | null;
  overkill: number | null;
};

export type LedgerMemberRow = {
  characterId: string;
  pullsPresent: number;
  firstDeaths: number;
  earlyDeaths: number;
  deaths: number;
  /** firstDeaths / pullsPresent, expressed per 10 pulls. */
  firstDeathRate: number;
  earlyDeathRate: number;
  deathsPerPull: number;
  topKillingAbility: { name: string; count: number } | null;
  /** Wipe-death times (ms into pull), for the drill-down histogram. */
  deathTimes: number[];
  /** Deaths on KILL pulls, kept separate from the wipe metric. */
  killDeaths: number;
};

export type LedgerEncounter = {
  encounterId: number;
  difficulty: number;
  /** All wipe pulls (for display). */
  wipePulls: number;
  /** Wipe pulls whose deaths we actually have — the rate denominator basis. */
  observedWipePulls: number;
  killPulls: number;
  members: LedgerMemberRow[];
};

export const MIN_WIPES = 5;
export const MIN_PULLS_PRESENT = 5;

const encKey = (encounterId: number, difficulty: number) =>
  `${encounterId}|${difficulty}`;

/**
 * Aggregate fights + deaths into per-encounter per-character rates. Only
 * encounters with ≥ MIN_WIPES wipe pulls are returned, and within each only
 * members present for ≥ MIN_PULLS_PRESENT wipes — too few samples to rank
 * fairly. Members are sorted by first-death rate (desc), the headline metric.
 */
export function aggregateLedger(
  fights: LedgerFight[],
  deaths: LedgerDeath[],
  opts: { minWipes?: number; minPullsPresent?: number } = {},
): LedgerEncounter[] {
  const minWipes = opts.minWipes ?? MIN_WIPES;
  const minPullsPresent = opts.minPullsPresent ?? MIN_PULLS_PRESENT;

  // Group fights + deaths by encounter|difficulty.
  const fightsByEnc = new Map<string, LedgerFight[]>();
  for (const f of fights) {
    const k = encKey(f.encounterId, f.difficulty);
    (fightsByEnc.get(k) ?? fightsByEnc.set(k, []).get(k)!).push(f);
  }
  const deathsByEnc = new Map<string, LedgerDeath[]>();
  for (const d of deaths) {
    const k = encKey(d.encounterId, d.difficulty);
    (deathsByEnc.get(k) ?? deathsByEnc.set(k, []).get(k)!).push(d);
  }

  const out: LedgerEncounter[] = [];
  for (const [k, encFights] of fightsByEnc) {
    const wipeFights = encFights.filter((f) => !f.kill);
    const killFights = encFights.filter((f) => f.kill);
    // Only deaths-observed wipes are eligible to rank — see LedgerFight.observed.
    const observedWipes = wipeFights.filter((f) => f.observed);
    if (observedWipes.length < minWipes) continue;

    const encDeaths = deathsByEnc.get(k) ?? [];
    const wipeDeaths = encDeaths.filter((d) => !d.kill);
    const killDeaths = encDeaths.filter((d) => d.kill);

    // pullsPresent per character: OBSERVED wipe pulls where they were in the
    // group (denominator basis — unobserved pulls can't show a first death).
    const pullsPresent = new Map<string, number>();
    for (const f of observedWipes) {
      for (const c of f.presentCharacterIds) {
        pullsPresent.set(c, (pullsPresent.get(c) ?? 0) + 1);
      }
    }

    // Per-character death tallies (matched deaths only).
    type Tally = {
      first: number;
      early: number;
      total: number;
      abilities: Map<string, number>;
      times: number[];
      kills: number;
    };
    const tally = new Map<string, Tally>();
    const get = (c: string): Tally => {
      let t = tally.get(c);
      if (!t) {
        t = { first: 0, early: 0, total: 0, abilities: new Map(), times: [], kills: 0 };
        tally.set(c, t);
      }
      return t;
    };
    for (const d of wipeDeaths) {
      if (d.characterId == null) continue;
      const t = get(d.characterId);
      t.total++;
      if (d.deathOrder === 0) t.first++;
      if (d.deathOrder <= 2) t.early++;
      t.times.push(d.msIntoPull);
      if (d.killingAbilityName) {
        t.abilities.set(
          d.killingAbilityName,
          (t.abilities.get(d.killingAbilityName) ?? 0) + 1,
        );
      }
    }
    for (const d of killDeaths) {
      if (d.characterId == null) continue;
      get(d.characterId).kills++;
    }

    const members: LedgerMemberRow[] = [];
    // A member qualifies if present for enough wipes (rate denominator).
    for (const [characterId, present] of pullsPresent) {
      if (present < minPullsPresent) continue;
      const t = tally.get(characterId);
      const first = t?.first ?? 0;
      const early = t?.early ?? 0;
      const total = t?.total ?? 0;
      let topAbility: { name: string; count: number } | null = null;
      if (t) {
        for (const [name, count] of t.abilities) {
          if (!topAbility || count > topAbility.count) topAbility = { name, count };
        }
      }
      members.push({
        characterId,
        pullsPresent: present,
        firstDeaths: first,
        earlyDeaths: early,
        deaths: total,
        firstDeathRate: (first / present) * 10,
        earlyDeathRate: (early / present) * 10,
        deathsPerPull: total / present,
        topKillingAbility: topAbility,
        deathTimes: t?.times ?? [],
        killDeaths: t?.kills ?? 0,
      });
    }
    members.sort(
      (a, b) =>
        b.firstDeathRate - a.firstDeathRate ||
        b.earlyDeathRate - a.earlyDeathRate ||
        b.deaths - a.deaths,
    );

    out.push({
      encounterId: encFights[0]!.encounterId,
      difficulty: encFights[0]!.difficulty,
      wipePulls: wipeFights.length,
      observedWipePulls: observedWipes.length,
      killPulls: killFights.length,
      members,
    });
  }

  // Most-wiped encounters first (where the coaching attention goes).
  out.sort((a, b) => b.wipePulls - a.wipePulls);
  return out;
}
