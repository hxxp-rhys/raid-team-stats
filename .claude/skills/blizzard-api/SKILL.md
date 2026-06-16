---
name: blizzard-api
description: Use this skill whenever you call the Blizzard / Battle.net API in this project (app-token or user-OAuth requests for character summary, equipment, M+, raids, guild roster) OR configure Battle.net OIDC login. It is the single source of truth for auth flow, endpoints, namespaces, rate limits, and the non-obvious gotchas. If anything here is contradicted by the live API or the code, fix this file in the same session.
---

# Blizzard / Battle.net API

Region-aware REST API + OIDC login. Code lives in
[src/server/ingestion/blizzard/](../../../src/server/ingestion/blizzard/)
and the Auth.js config in [src/server/auth/index.ts](../../../src/server/auth/index.ts).
**Always go through `blizzardClient()` — never hand-roll a `fetch`.**

## Two auth modes

| Mode | Token | Used for |
|---|---|---|
| `{ kind: "app" }` | `client_credentials` app token, cached in Redis | guild roster, character summary/equipment/M+/raids — anything public |
| `{ kind: "user", accessToken }` | the linked user's OAuth `Account.access_token` | only `/profile/user/wow` (the user's own character list, at link time) |

**App token:** `POST https://{region}.battle.net/oauth/token`
(`battleNetOAuthBase`), `grant_type=client_credentials`, HTTP Basic
`BLIZZARD_CLIENT_ID:BLIZZARD_CLIENT_SECRET`. Cached at Redis key
`bnet:app-token:{region}` for `expires_in − 30min` (24h tokens). The
client refreshes transparently; a `401` on an app request deletes the
cache key and retries once.

## Request shape

- Base: `https://{region}.api.blizzard.com` (`blizzardApiBase`).
- Every request auto-adds `?namespace=…&locale=en_US`. Namespace is
  `profile-{region}` for everything we use.
- Headers: `Authorization: Bearer …`, `Accept: application/json`,
  `User-Agent: raid-team-stats/0.1 (+https://github.com/hxxp-rhys/raid-stats)`.
- Responses are zod-validated; schemas use `.passthrough()` for Midnight
  forward-compat. A schema mismatch **throws** (logs first 5 issues).

## Endpoints (see `endpoints.ts`)

| Helper | Path | Auth |
|---|---|---|
| `userCharacters` | `/profile/user/wow` | **user** |
| `characterSummary` | `/profile/wow/character/{realm}/{name}` | app |
| `characterEquipment` | `…/equipment` | app |
| `characterMythicKeystoneIndex` | `…/mythic-keystone-profile` | app |
| `characterMythicKeystone` | `…/mythic-keystone-profile/season/{seasonId}` | app |
| `characterRaids` | `…/encounters/raids` | app |
| `characterProfessions` | `…/professions` | app |
| `guildRoster` | `/data/wow/guild/{realm}/{guild}/roster` | app |
| `professionSkillTier` | `/data/wow/profession/{id}/skill-tier/{tierId}` (**static-{region}**) | app |

Realm/character/guild slugs go through `@/lib/realm`
(`buildCharacterPath`, `normalizeRealmSlug`) — don't build slugs by hand.

**`professionSkillTier` is the ONLY `static-{region}` namespace use in the app**
(everything else is `profile-{region}`). It returns the profession's recipe
`categories[]` in **in-game display order** (Recrafting → Profession Equipment →
Weapons → Armor → … → House Decor), each `{name, recipes:[{id,name}]}`. It's how
we sort a character's known recipes "like in game": intersect the character's
`known_recipes` ids with these ordered categories. The category structure is
**static per patch + identical for everyone**, so it's Redis-cached (key
`prof-cat:{region}:{profId}:{tierId}`, 7-day TTL) in
[recipe-categories.ts](../../../src/server/professions/recipe-categories.ts) —
NOT fetched per character. Char `/professions` `known_recipes` is a FLAT
`{id,name}` list with NO meaningful order — the category order MUST come from
this game-data endpoint.

## Rate limits

Hard limits: **100 req/sec, 36 000 req/hour**. Enforced by `blizzardBucket`
(capacity 100, refill 95/s) in
[rate-limit/token-bucket.ts](../../../src/server/ingestion/rate-limit/token-bucket.ts).
Bulk callers (Tier-B/C) pass `minFloor` to reserve headroom for
interactive + hourly paths. `429` → honor `Retry-After`, retry once.

## ⚠️ Gotchas (these have each cost real debugging time)

1. **Guild roster uses the `profile-{region}` namespace, not `dynamic-`,**
   despite living under `/data/wow/`. Blizzard's own docs are wrong here;
   `profile-{region}` is what the gateway actually accepts.
2. **Battle.net OIDC login needs `checks: ["pkce", "state", "nonce"]`.**
   Auth.js v5 defaults OIDC to `["pkce"]` only. Battle.net *requires*
   `state` ("The state parameter must be provided") even with PKCE, and
   always returns a `nonce` claim in the id_token — omit `nonce` from
   checks and you get "unexpected ID Token nonce claim value".
3. **Never override `authorization.params.redirect_uri`.** Auth.js uses
   `provider.callbackUrl` (`/api/auth/callback/battlenet`) at the token
   exchange regardless of the authorize request. Overriding one side →
   `invalid_grant: Redirect URI mismatch`. The public callback
   `/bnet-login-callback` (env `BATTLENET_REDIRECT_URI`, registered with
   the Blizzard dev console) just *proxies* into the Auth.js catch-all.
4. **`AUTH_URL` must be pinned** (≈ `APP_URL`). Without it Auth.js derives
   the origin from the request and produces inconsistent `redirect_uri`
   between direct-localhost and proxied access → `invalid_grant`.
5. **Battle.net is a link flow, not a primary identity.** The `signIn`
   callback refuses to create users from Battle.net; the user must already
   have an email-verified Credentials account.

## Env vars

`BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET`,
`BLIZZARD_REGION` (`us|eu|kr|tw`, default `us`),
`BATTLENET_REDIRECT_URI` (default `http://localhost:3000/bnet-login-callback`).
US+EU only at launch; KR/TW need separate OAuth client registration.
