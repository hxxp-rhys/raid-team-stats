# WoW Audit integration

Status: **scaffolding only**. The schema, encrypted-key storage, settings
UI, and a generic HTTP client wrapper are all in place. The endpoint paths
and zod response schemas are educated placeholders — they'll be wrong until
you replace them with the real WoW Audit docs.

## Activating once you have docs

1. Get the API key from your WoW Audit team's settings page (URL pattern:
   `https://wowaudit.com/<region>/<realm>/<team>/main/api`).
2. As guild OWNER or OFFICER, paste the key + (optional) team id + base URL
   into the WoW Audit card on `/guild/<id>`. The key is AES-256-GCM
   encrypted via the same cipher that protects OAuth refresh tokens; the UI
   only ever shows the last 4 characters as a hint.
3. **Tighten `src/server/ingestion/wowaudit/schemas.ts`** to match the real
   response shapes. The placeholder uses `.passthrough()` everywhere and
   marks every field optional — once you have the spec, drop `.optional()`
   on the fields that are guaranteed and add `.transform()`s to normalize
   types.
4. **Update `src/server/ingestion/wowaudit/client.ts`**:
   - Replace the `paths` object with the real endpoint paths.
   - Adjust `authHeader()` if WoW Audit uses a custom header name (e.g.
     `X-Api-Key` rather than `Authorization`).
   - Tune the rate-limit by editing `wowauditBucket` in
     `src/server/ingestion/rate-limit/token-bucket.ts`.
5. Wire the client into the ingestion pipeline. The simplest place: extend
   `src/server/ingestion/jobs/manual-roster-refresh.ts` to also load
   WoW Audit data and write a new snapshot row with `source: WOWAUDIT`.
6. Add a widget that reads WoW Audit snapshots specifically, or merge the
   data into the existing widgets (e.g. show WoW Audit's raid attendance
   number on the iLvL roster widget).

## What's already done

- Schema: `Guild.wowauditApiKey` (encrypted), `wowauditTeamId`,
  `wowauditBaseUrl` columns + `SnapshotSource.WOWAUDIT` enum value.
- Config: `src/server/ingestion/wowaudit/config.ts` exposes
  `setConfig` / `clearConfig` / `getPublicStatus` / `loadDecryptedConfig`.
  The plaintext key is only ever read inside the BullMQ worker process.
- Client: `WowauditClient.forGuild(guildId)` resolves the per-guild
  config, decrypts the key, and exposes `getTeam()` / `getRoster()` /
  `ping()`. Returns `null` if the guild has no key configured (callers
  should skip rather than throw).
- tRPC: `guild.wowauditStatus` (read), `guild.setWowauditConfig` (write,
  officer+), `guild.clearWowauditConfig`, `guild.testWowauditConnection`.
- UI: `WowauditConfigCard` on the guild detail page.

## Don't activate without

- A working API key tested via `ping()` against a real endpoint.
- A schema-tightening pass — the permissive placeholders WILL silently
  accept garbage and break downstream widgets in unexpected ways.
- A rate-limit decision — the default 30 burst / 0.5 rps is conservative
  but might be too slow for a 25-character roster sync.

## Audit + security notes

- Rotating a key: paste the new key into the same settings card and click
  "Rotate key". The old ciphertext is overwritten in a single transaction;
  no need to clear-then-set.
- Removing a key: "Remove key" nulls all three columns + writes a
  `RAID_TEAM_LEADERSHIP_TRANSFERRED`-style audit entry (event type to be
  added when this integration actually goes live).
- A leaked DB row reveals only the AES-GCM envelope; without
  `TOKEN_ENCRYPTION_KEY` the key cannot be decrypted.
