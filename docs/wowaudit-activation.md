# WoW Audit activation

The WoW Audit integration is shipped as scaffolding only. The endpoint
paths, response shapes, and auth-header format are educated guesses until
the real docs land. This page documents what to change once you have
them.

## What's already in place

- **Schema:** `Guild.wowauditApiKey` (AES-256-GCM-encrypted),
  `wowauditTeamId`, `wowauditBaseUrl`.
- **Config store:** `src/server/ingestion/wowaudit/config.ts` — encrypt
  on write, decrypt on read inside the worker, expose only a
  last-4-character preview to the UI.
- **Client:** `src/server/ingestion/wowaudit/client.ts` — bucket-aware
  fetch wrapper, `forGuild(guildId)` factory, `ping()` /
  `getTeam()` / `getRoster()` methods.
- **Schemas:** `src/server/ingestion/wowaudit/schemas.ts` — permissive
  zod schemas with `.passthrough()`.
- **Rate limit:** `wowauditBucket` in
  `src/server/ingestion/rate-limit/token-bucket.ts` (30 burst,
  0.5 req/sec — conservative until real limits are known).
- **tRPC:** `guild.wowauditStatus` / `setWowauditConfig` /
  `clearWowauditConfig` / `testWowauditConnection`.
- **UI:** `WowauditConfigCard` on the guild detail page (officer+ only).
- **Snapshot source enum:** `WOWAUDIT` is already a valid value, ready
  for ingestion writes.

## To activate

1. **Confirm the auth header.** Edit `authHeader(key)` in
   `client.ts`. Replace `Authorization: key` with whatever WoW Audit
   actually wants:
   - `Authorization: Bearer ${key}` if bearer-style
   - `{ "X-Api-Key": key }` if a custom header

2. **Fix the endpoint paths.** Replace the `paths` object in
   `client.ts` with the real route map (e.g. `/v1/team`, `/v1/characters`,
   `/v1/period/{id}`).

3. **Tighten the schemas.** Open
   `src/server/ingestion/wowaudit/schemas.ts`. The shapes are
   `.passthrough()` placeholders. Add real fields and drop the
   passthrough where the spec is closed.

4. **Tune the bucket.** Set `wowauditBucket.capacity` and
   `refillPerSec` in `token-bucket.ts` to whatever WoW Audit's
   per-team limits actually are. The conservative defaults won't
   keep up with a 25-character team if you run sync more than ~every
   30 minutes.

5. **Add ingestion writes.** In a Tier A / Tier B job, after
   `WowauditClient.forGuild()` returns a non-null client, call
   `getRoster()` and write `CharacterSnapshot` / `EquipmentSnapshot`
   rows with `source: "WOWAUDIT"`. Hash dedup is handled by the
   `snapshots.ts` helpers.

6. **Update SECURITY.md.** Note the new external dependency and any
   data-sharing implications (especially if WoW Audit returns
   personally-identifying fields beyond character + realm).

## What NOT to change

- The encrypted-storage path. Even when you have a real key, do not
  store it plaintext. The token cipher round-trips through the same
  AES-256-GCM envelope used for OAuth tokens; it has been unit-tested
  for tamper and length validation.
- The `getPublicStatus()` shape. The UI relies on `{ configured,
  keyHint, teamId, baseUrl }` — keep the surface symmetric so the
  card stays clean.

## After activation

Run the existing testing matrix:

```bash
docker compose up -d
docker compose exec web npx prisma migrate deploy
docker compose exec web sh -c "
  # set the env so the worker has fresh creds
  WOWAUDIT_TEAM_API_KEY=...                  # your real key
"
# then exercise via the UI: paste the key, click Test connection.
```

A passing `Test connection` confirms the auth header + base URL agree
with reality. Failing with `401/403` means the header name is wrong.
Failing with `404` means the path is wrong.
