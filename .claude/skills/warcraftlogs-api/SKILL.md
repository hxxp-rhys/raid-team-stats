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
| `ZONE_ENCOUNTERS_QUERY` | boss list for a zone |
| `buildCharacterEncounterRankingsQuery(ids)` | per-encounter `ranks[]` (has `startTime`/`report`), aliased `e<id>` so it's **one HTTP request per character** |

`character()` args are `name`, `serverSlug`, `serverRegion`.

## ⚠️ Gotchas

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

## Env vars

`WCL_CLIENT_ID`, `WCL_CLIENT_SECRET`,
`WCL_HOURLY_POINTS_BUDGET` (default 17000),
`WCL_REDIRECT_URI` (reserved, unused in v1),
`WCL_RAID_ZONE_ID` (process.env pin — strongly recommended in prod).

Scaling note: the 17k budget is shared across all tracked rosters. ~25–30
chars hourly ≈ ~3 000 pts/hr. 5+ rosters of 25 → request a higher WCL
allocation or move to per-guild WCL client credentials.
