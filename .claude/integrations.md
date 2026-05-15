# External integrations

Four upstream sources. Each has its own client + zod schemas + token-
bucket entry. Clients live in `src/server/ingestion/<source>/`.

## Blizzard Battle.net API

### Auth

Two modes:

- **App token** (client_credentials) for guild roster + character data.
  Cached in Redis with a 30-minute safety margin under the documented
  24h lifetime. Refresh on 401, retry once, alert on the second 401.
- **User OAuth** (authorization_code) for `/profile/user/wow` — the
  authoritative "which characters does this BattleTag own" endpoint.
  Tokens stored encrypted via the Prisma extension; only used at the
  link / discover step (not on Tier A/B/C).

### Endpoints we hit

- `GET /data/wow/guild/{realm}/{slug}/roster` — Tier B + Tier C
- `GET /profile/wow/character/{realm}/{name}` — summary
- `GET /profile/wow/character/{realm}/{name}/equipment` — Tier A
- `GET /profile/wow/character/{realm}/{name}/mythic-keystone-profile/season/{id}` — Tier A
- `GET /profile/wow/character/{realm}/{name}/encounters/raids` — Tier A
- `GET /profile/user/wow` — discover flow only

### Rate limits

100 req/sec / 36,000 req/hour, **per client ID** (not per user). The
token bucket reserves 95 req/sec to leave headroom. Bulk callers
(Tier A, Tier B) pass `minFloor` so interactive paths always have
capacity.

### Custom callback URL

The Battle.net app is configured with `BATTLENET_REDIRECT_URI` (default
`http://localhost:3000/bnet-login-callback`, prod
`https://raiders.hxxp.io/bnet-login-callback`). Auth.js's BattleNet
provider gets `authorization.params.redirect_uri = env.BATTLENET_REDIRECT_URI`
so Battle.net redirects to our custom URL. The custom URL is a thin
proxy route that forwards into Auth.js's catch-all callback handler at
`/api/auth/callback/battlenet`.

This pattern matches the sibling `wow-tankgear` project (separate
redirect URIs per purpose — login vs gear-import vs link).

## Warcraft Logs v2

GraphQL, client credentials auth.

### Tier

User holds **Platinum** = 18,000 points/hour. Token bucket reserves
17,000 for sync (`WCL_HOURLY_POINTS_BUDGET=17000` env), 1,000 for ad-hoc
queries. A 30-character tracked roster at hourly sync consumes
~3,000 pts/hr — comfortably inside.

If the platform expands past ~5 tracked rosters of 25 each across
multiple guilds, we'll need to either request a higher allocation or
move to per-guild WCL OAuth credentials.

### Queries

Currently scaffolded but not heavily used in Tier A yet. The pattern is
GraphQL via `graphql-request` + zod-validated responses + the retry
decorator that auto-refreshes the bearer token on 401.

### Custom callback URL

`WCL_REDIRECT_URI` registered with the WCL console. Currently unused —
v1 is client-credentials-only. v1.1 will add a user-link flow at
`/wcl-callback`.

## Raider.IO

Plain REST, optional API key for higher tier. Public endpoints work
without auth. Token bucket at ~4 req/sec.

Endpoint: `/api/v1/characters/profile?fields=...` with comma-separated
field list controlling which expensive computations are included.

## WoW Audit

**Status: scaffolded only.** Schema fields + encrypted-key storage +
generic HTTP client + settings UI are all in place. Endpoint paths and
zod response schemas in `src/server/ingestion/wowaudit/schemas.ts` are
permissive `.passthrough()` placeholders until real docs arrive.

To activate (see `docs/wowaudit.md` for the full checklist):

1. The team admin pastes their team API key into the guild settings
   card (`/guild/<id>` → WoW Audit section). Encrypted at rest with the
   same AES-256-GCM cipher used for OAuth tokens.
2. Tighten `schemas.ts` — drop `.optional()` from fields you know are
   guaranteed; add `.transform()`s where types need coercion.
3. Update `client.ts:paths` — replace the educated-guess `/team` and
   `/characters` paths with the real endpoints.
4. Confirm `authHeader()` — the header name (`Authorization` vs
   `X-Api-Key`) needs verification against the docs.
5. Tune `wowauditBucket` in `rate-limit/token-bucket.ts` to match the
   documented limits.

Zero ingestion-pipeline rewiring needed — the surface that the rest of
the app talks to is already in place.

## Custom callback URL routing

For Battle.net (and the future WCL user-link), we registered specific
non-Auth.js paths with the OAuth provider:

- `https://raiders.hxxp.io/bnet-login-callback` → proxy → Auth.js
- `https://raiders.hxxp.io/wcl-callback` → reserved for v1.1

The proxy route lives in `src/app/bnet-login-callback/route.ts` and
rewrites the URL to `/api/auth/callback/battlenet` before invoking
`handlers.GET`, preserving query params + cookies.

## Why the WoW Analyzer / Archon.gg integrations are missing

Per the original plan, both were dropped after the API discovery agent
confirmed neither publishes a public API. Scraping is ToS-risky and
fragile. The placeholder is "link out" buttons per character — not yet
implemented in the UI but the data is there.
