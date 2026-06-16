---
name: warcraftlogs-api
description: Use this skill whenever you query the Warcraft Logs v2 GraphQL API in this project (character zone/encounter rankings, resolving the current raid tier) or touch its hourly points budget. It is the single source of truth for the GraphQL endpoint, auth, queries, the points-budget accounting, and the JSON-scalar/zone-resolution gotchas. If the live API or code contradicts this file, fix it in the same session.
---

# Warcraft Logs v2 API

GraphQL, **server-to-server client-credentials only**. Code:
[src/server/ingestion/warcraftlogs/](../../../src/server/ingestion/warcraftlogs/).
**Always go through `warcraftLogsClient().query()`.** User-linked WCL is
deferred to v1.1 (`WCL_REDIRECT_URI` is reserved but unused in v1).

## Endpoints & auth

- OAuth: `POST https://www.warcraftlogs.com/oauth/token`,
  `grant_type=client_credentials`, HTTP Basic
  `WCL_CLIENT_ID:WCL_CLIENT_SECRET`. Cached at Redis `wcl:app-token` for
  `expires_in − 30min`. `401` → delete key, retry once.
- GraphQL: `POST https://www.warcraftlogs.com/api/v2/client`
  (the **client** endpoint — not `/api/v2/user`).
- `429` → honor `Retry-After`, up to 3 attempts.

## Points budget (the thing that gets you rate-limited)

User holds **Platinum: 18 000 points/hr**. Budget is
`WCL_HOURLY_POINTS_BUDGET` (default **17 000**, ~1k headroom).

- Spend tracked per **UTC hour** at Redis `wcl:points:{YYYY-MM-DD-HH}`.
- **Pre-flight refusal:** if `used + estimatedPoints > budget`, the call
  throws *before* hitting the network. Always pass a sane
  `estimatedPoints` for heavy queries.
- After each response the **authoritative** spend is read from
  `extensions.rateLimitData.pointsSpentThisHour` and written back; if
  absent, the estimate is charged so we always make forward progress.
- Separately, `wclBucket` (capacity 200, refill 5/s = 18 000/hr) smooths
  per-second bursts. Points budget ≠ token bucket — both apply.

## Queries (see `queries.ts`)

| Const | Purpose |
|---|---|
| `CHARACTER_ZONE_RANKINGS_QUERY` | season `zoneRankings` for one char/zone |
| `WCL_RAID_ZONES_QUERY` | flat `worldData.zones { id name frozen }` |
| `ZONE_ENCOUNTERS_QUERY` | boss list for a zone — **dead code today** (exported, never imported; the boss list is derived from the zoneRankings JSON instead) |
| `buildCharacterEncounterRankingsQuery(ids)` | per-encounter `ranks[]` (has `startTime`/`report`), aliased `e<id>` so it's **one HTTP request per character**. Takes `$metric: CharacterRankingMetricType` (NOT the `CharacterPageRankingMetricType` zoneRankings uses — different enums, overlapping members dps/hps/tankhps). Sync passes `dps` today; role-true ingestion is a planned flag-flip. **`ranks[]` is the character's FULL public-kill history for that encounter (one entry per kill, not top-N), each with a per-kill `startTime` (top-level OR under `report.startTime`) + `rankPercent`/`percentile`.** It's stored verbatim in `WclParseSnapshot.rawPayload.ranks` and is the source of truth for BOTH the σ/volatility stat AND the week-over-week Trend (bucketed by each kill's week via `extractKillRanks`). The legacy `weekPercentile` COLUMN only ever captured the CURRENT lockout's best, so never drive the trend off it — rebuild from `ranks` |
| `GUILD_REPORTS_QUERY` | GRS discovery: `reportData.reports(guildID, zoneID, startTime, limit)` → `{ code title startTime endTime revision zone{id} }`, newest-first, epoch-ms floats. ~2 pts. Keyed by numeric WCL guild id — one pass per distinct team log SOURCE (guild default or per-team override). `guildTagID`/`userID` are verified args for future source kinds |
| `GUILD_ID_LOOKUP_QUERY` | `guildData.guild(name, serverSlug, serverRegion){ id name }` — one-time resolution of a guild's default WCL source (cached on `Guild.wclGuildId`). ~2 pts |
| `GUILD_BY_ID_QUERY` | `guildData.guild(id){ id name server{name slug} }` — validates a user-entered per-team source and echoes its identity for confirmation. ~2 pts |
| `REPORT_FIGHTS_QUERY` | GRS detail: `report(code)` → `fights(killType: Encounters)` (id, encounterID, difficulty, kill, size, bossPercentage, fightPercentage, lastPhase, lastPhaseIsIntermission, startTime/endTime **report-relative ms**, friendlyPlayers, keystoneLevel) + `masterData.actors(type: "Player")`. ~8 pts |
| `REPORT_DEATHS_QUERY` | GRS deaths layer (first_death_ledger): `report(code)` → `events(dataType: Deaths, killType: Encounters, fightIDs, startTime, limit)` → `ReportEventPaginator { data, nextPageTimestamp }`. `data` is a **JSON scalar** (array). Each death-event = `{ timestamp(report-relative ms), type:"death", sourceID:-1, targetID(=who died, report-local actor id), abilityGameID:0, fight(=fightId), killerID, killingAbilityGameID }`. **Killer attribution is `killerID` + `killingAbilityGameID`, NOT `abilityGameID` (always 0 on deaths).** `killerID` -1/0 = environment/none. **TIME-CURSOR paginated:** loop passing the prior page's `nextPageTimestamp` back as `$startTime` until null. Verified live 2026-06-14 (104 events / 12 fights, multi-page). ~5 pts/page |
| `REPORT_DEATHS_TABLE_QUERY` | GRS deaths layer overkill drill-down: `report(code)` → `table(dataType: Deaths, killType: Encounters, fightIDs)` — ONE JSON-scalar blob, NOT paginated. `data.entries[]` = `{ id(=actor), name, timestamp, fight, overkill, deathWindow, killingBlow{ name, guid(=killingAbilityGameID), abilityIcon }, damage{sources[]}, events[] }`. **`overkill` + the killing-ability NAME live ONLY here** (the events query has the ability GAME ID but no name, no overkill). Join to events by (fight, actorId, ~timestamp); the table ts can differ ±2ms from the event ts. ~5 pts |

`character()` args are `name`, `serverSlug`, `serverRegion`.

| `table(dataType: DamageTaken, abilityID: Float)` | learning_curve avoidable-damage: per-player damage TAKEN from ONE ability, summed across the passed `fightIDs`. **VERIFIED LIVE 2026-06-14** (was research A.7 #14, never-probed — now confirmed working). `data.entries[]` = `{ name, id, guid, type(=class), total, totalReduced, hitCount, tickCount, activeTime, uptime, … }`. `abilityID` is a **Float** var. Per-REPORT aggregate over the fightIDs — to bucket early-vs-late pulls, pass each bucket's fightIDs in a SEPARATE call. Pair with the deaths layer's `killingAbilityGameId` (the abilities that kill people ARE the avoidable mechanics → auto-curated, no per-boss hand-curation). ~4 pts/call |

**Deaths layer ingestion (`guild-report-sync.ts`):** fetched per detail-fetched report inside the same `$transaction` as fights (best-effort — a deaths failure keeps the fights and preserves prior deaths; only a successful fetch replaces them). Stored in `WclFightDeath` (replaced wholesale like `WclFight`), with `deathOrder` precomputed per fight by ascending timestamp (0 = first death) so the widget read is pure. `WclReport.deathsFetchedAt` marks the attempt (null = never) so the bounded self-healing backfill sweep (`MAX_DEATHS_BACKFILL`/run) never re-fetches a genuinely death-free report. `backfillReportDeaths(code)` populates the layer for pre-existing reports without re-fetching fights. **Lead the widget with death ORDER, not the killing ability** — attribution lies (tiny ticking DoTs land the blow; overkill disambiguates).

### Guild Report Sync (GRS) budget shape

Hourly per-guild job (`guild-report-sync.ts`, cron `20 * * * *` ET):
discovery ~2 pts/guild/hr; each new/changed report ~8 pts ONCE
(revision-gated re-fetch, frozen forever 48h after the report ends);
`MAX_DETAIL_FETCHES = 15`/run caps the first-backfill burst (~122 pts).
Discovery `limit: 25` newest-first — a full page means older reports in
the window are permanently skipped (the verified `page` arg is the fix
if that ever matters).

## ⚠️ Gotchas

0. **The public v2 docs site is 404 (observed 2026-06-11/12)** — all
   mirrors of `warcraftlogs.com/v2-api-docs/` fail. Verify schema
   questions with a targeted live introspection instead (one batched
   `__type(name:"…"){fields{name args{name}}}` POST ≈ 2 pts).
0b. **`zoneRankings`' top-level `partition` is a request ECHO, not the
   real partition** — when no partition arg is passed it returns the
   sentinel `-1` ("current"). The REAL ranking partition is
   `rankings[].allStars.partition` (live: zone 46 → `2` while top-level
   echoed `-1`). Never persist/display the top-level value; reject
   negatives as sentinels.
1. **`zoneRankings` and `encounterRankings` are JSON scalars** in WCL's
   schema, not typed objects. Zod-model them as `z.unknown()` /
   `z.record()` with `.passthrough()`. Don't try to select sub-fields.
2. **Resolve the current raid tier with `currentRaidZoneId()`**, in this
   priority: (1) `process.env.WCL_RAID_ZONE_ID` explicit pin — what prod
   uses, most reliable; (2) Redis cache `wcl:current-raid-zone` (6h);
   (3) live `worldData.zones`: highest-`id` zone that is **not** `frozen`
   and **not** PTR / Mythic+ / Delve (name regex). Returns `null` if WCL
   is unreachable and nothing is pinned/cached — callers must have a
   fallback.
3. **Use `worldData.zones`, NOT `worldData.expansions[].zones`.** The
   expansions variant lumps Classic seasonal expansions in with large
   ids and mis-resolves the tier.
4. `WCL_RAID_ZONE_ID` is read directly via `process.env`, **not** through
   `@/env` — it isn't in the env.ts schema. Set it in the container env.
5. **`events(dataType: DamageTaken)` has an INVERTED actor filter.** To get
   "boss damage a player took", filter by **`sourceID: <playerActorId>`** with
   `hostilityType: Friendlies` (the player is the "source" of the *taken-damage*
   view). The returned rows still label `sourceID`=attacker(boss),
   `targetID`=victim(player) — so the parser reads the boss off `sourceID`.
   Pitfalls, all verified live 2026-06-15 (report `WhwV1qZjym67xTLA`, fight 33,
   actor 7 = Ravagunn):
   - `targetID: N` → **0 rows** (the seductive-but-wrong filter; `targetID`
     does not select the victim here).
   - `targetID: N` **+** `hostilityType: Enemies` → returns the player's
     **OUTGOING** damage to bosses (because `Enemies` = damage taken *by
     enemies*). This was the prior bug: the death lightbox timeline showed the
     player hitting the boss instead of the boss hitting the player.
   - ✅ `sourceID: N` **+** `hostilityType: Friendlies` → the boss→player hits.
     Equivalent: `dataType: DamageDone, hostilityType: Enemies, targetID: N`.
   Used by `DEATH_DAMAGE_TAKEN_QUERY` for the cooldown_usage death lightbox.
   Note: many deaths have **no `overkill` flag and a null killing ability**, so
   the fatal hit is detected as the last row with `amount > 0` (trailing rows
   near death are often fully-absorbed/immune 0-damage ticks).
6. **Damage/heal event rows carry a `buffs` string** = a `.`-delimited list of
   every buff id active ON THE TARGET at that instant (e.g. `"871.33206."`).
   So "which defensives were up when the fatal hit landed" is read straight off
   the killing-blow row — no separate buff-window reconstruction needed
   (`src/lib/death-context.ts`). `hitPoints`/`maxHitPoints` and
   `events(dataType: Resources)` are NOT populated on raid damage rows in
   practice — don't rely on an exact HP curve; use unmitigated/absorbed +
   the `Healing` stream as the proxy. The `deathContext` procedure caches its
   ~3-call window in Redis (`death-ctx:…`), 7d for a frozen report.

## Env vars

`WCL_CLIENT_ID`, `WCL_CLIENT_SECRET`,
`WCL_HOURLY_POINTS_BUDGET` (default 17000),
`WCL_REDIRECT_URI` (reserved, unused in v1),
`WCL_RAID_ZONE_ID` (process.env pin — strongly recommended in prod).

Scaling note: the 17k budget is shared across all tracked rosters. ~25–30
chars hourly ≈ ~3 000 pts/hr. 5+ rosters of 25 → request a higher WCL
allocation or move to per-guild WCL client credentials.
