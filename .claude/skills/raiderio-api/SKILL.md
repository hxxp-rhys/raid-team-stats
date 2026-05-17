---
name: raiderio-api
description: Use this skill whenever you call the Raider.IO API in this project (character profile — M+ score, weekly/recent runs, raid progression, gear). It is the single source of truth for the base URL, the fields catalog we use, rate limits, and why Raider.IO is the authoritative M+ score. If the live API or code contradicts this file, fix it in the same session.
---

# Raider.IO API

Plain REST, **public** (no OAuth). Code:
[src/server/ingestion/raiderio/](../../../src/server/ingestion/raiderio/).
**Always go through `raiderIOClient().get()`.**

## Endpoint & auth

- Base: `https://raider.io/api/v1`.
- No auth required. If `RAIDERIO_API_KEY` is set it's sent as
  `Authorization: Bearer …` (some endpoints grant higher quota with it).
- `User-Agent: raid-team-stats/0.1`. Responses zod-validated; mismatch
  throws.
- `429` → honor `Retry-After`, one retry, then throw.

## Rate limits

Documented ~**300 req/min**; we reserve to ~250/min via `raiderioBucket`
(capacity 60, refill 4/s) in
[rate-limit/token-bucket.ts](../../../src/server/ingestion/rate-limit/token-bucket.ts).
**Raider.IO bills roughly proportional to response size** — always pass
an explicit minimal `fields` list, never fetch the whole profile.

## Character profile

`GET /characters/profile?region={r}&realm={slug}&name={name}&fields={csv}`

Build `fields` with `characterProfileFields(...)`. The fields this project
relies on (see `tracked-member-sync.ts`):

- `mythic_plus_scores_by_season:current` — **authoritative community M+
  score**. Use `mythic_plus_scores_by_season[0].scores.all`; fall back to
  Blizzard's internal `current_mythic_rating.rating` only if RIO is down.
- `mythic_plus_recent_runs` — used for the **exact** weekly run count /
  highest key (filter by `completed_at` within the weekly window).
- `mythic_plus_weekly_highest_level_runs`
- `raid_progression` — clean season-cumulative summary, keyed by raid
  slug; pick the entry with the most kills as the current raid.
- `gear`

## Why Raider.IO and not Blizzard for M+

The number players actually quote is the Raider.IO score, and RIO's
`raid_progression` is a far cleaner season summary than Blizzard's raw
encounter feed. Blizzard remains the source for live equipment/enchants
and is the fallback when RIO is unavailable. Raider.IO is fetched **once
per character up-front** in the sync and reused by both the M+ and raid
steps (rate-limit friendly).

## Env vars

`RAIDERIO_API_KEY` (optional). Region passed lowercased (`us|eu|kr|tw`).
