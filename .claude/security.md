# Security

Quick reference. The canonical disclosure / response-policy doc is
`SECURITY.md` at the repo root.

## Defense-in-depth layers

1. **Reverse proxy** (Caddy in prod): TLS termination, HSTS, security
   headers as a belt-and-braces fallback.
2. **`src/proxy.ts`** (Next 16 proxy): per-request CSP nonce, IP rate-
   limit, security header set, strips client-supplied proxy headers
   unless `RATE_LIMIT_TRUST_PROXY=true`.
3. **`src/server/api/trpc.ts`** middlewares: same-origin check on
   mutations, log middleware, role-based authorization helpers
   (`assertGuildRole`, `assertRaidTeamRole`).
4. **DB schema**: cascade / SetNull / Restrict relations chosen to
   preserve audit trail on deletion. `Prisma.onDelete: Restrict` on
   `RaidTeam.leaderUserId` blocks user delete until leadership is
   transferred.

## Cryptography

| Use | Algorithm | Where |
|---|---|---|
| User passwords | Argon2id (m=64 MiB, t=3, p=1) | `src/server/crypto/kdf.ts` |
| OAuth tokens at rest | AES-256-GCM, per-message IV, versioned envelope | `src/server/crypto/token-cipher.ts` |
| MFA TOTP secret at rest | Same cipher as above | `src/server/auth/mfa.ts` |
| MFA recovery codes | Argon2id-hashed | `src/server/auth/mfa.ts` |
| Auth.js session | JWT (`AUTH_SECRET`) | Auth.js v5 default |
| Verify / reset tokens | SHA-256 of raw token; raw never persisted | `src/server/auth/tokens.ts` |
| Audit-log IPs | SHA-256 with daily-rotating salt | `src/server/security/audit.ts` |

`TOKEN_ENCRYPTION_KEY` is 32 raw bytes, base64-encoded. The cipher
envelope is `version(1B) | iv(12B) | tag(16B) | ciphertext`. A `version`
byte lets us rotate keys without a flag-day re-encryption.

## CSP nonce model

The proxy mints a fresh per-request nonce, sets it on BOTH the response
`Content-Security-Policy` header AND the forwarded request headers
(`X-CSP-Nonce` + a duplicate `Content-Security-Policy` on the request).
Next 16 reads the request CSP to tag its own bundle `<script>` tags with
the nonce. Without the request-side header, prerendered scripts ship
without nonces and `strict-dynamic` blocks them.

Server Components that want the nonce read it from
`headers().get('x-csp-nonce')` — but doing so forces dynamic rendering,
so wrap the consumer in `<Suspense>`.

## MFA

Two-step enrollment: `mfa.startEnrollment` returns the otpauth URL + base32
secret (one-time disclosure), the user scans / types it into their app,
then `mfa.confirmEnrollment` verifies a code, marks the secret enabled,
and returns 10 recovery codes (also one-time disclosure).

Disable requires BOTH the current password AND a fresh TOTP / recovery
code — two factors to undo the second factor. Defeats session-hijack
downgrades.

Recovery codes are single-use: matched via Argon2id `verify`, then
removed from `MfaSecret.recoveryCodes`.

## GDPR account deletion

`auth.deleteAccount` requires current-password confirmation. Pre-checks
for `RaidTeam` leadership (the schema's `onDelete: Restrict`) — if the
user still leads any team, we surface a "transfer leadership first"
error rather than letting Prisma throw a generic FK violation.

The audit log row is written **before** the delete, so the actor pointer
still resolves at write time. Post-delete, the FK `SetNull` rule keeps
the event row with `actorUserId = null` for the compliance window.

Cascade-deleted via the schema:
- `accounts`, `sessions`, `credential`, `mfaSecret` (auth surface)
- `characters` → all snapshots, raid-team memberships, guild-character
  links via further cascades
- `guildMemberships` (per-guild rows)
- `dashboards` owned by the user

NOT cascade-deleted (preserved with `SetNull`):
- `AuditLog` (compliance retention)
- `Guild.claimedByUserId` (preserves history of who claimed the guild)

## Rate limits

Defined in `src/server/security/rate-limit.ts`:

| Policy | Window | Limit |
|---|---|---|
| `globalIp` | 60s | 600 req |
| `authLoginPerIp` | 60s | 10 |
| `authLoginPerEmail` | 5min | 5 |
| `authSignupPerIp` | 1hr | 5 |
| `trpcMutationPerUser` | 60s | 120 |
| `manualSyncPerUser` | 10min | 1 |
| `manualSyncPerGuild` | 5min | 1 |

External API budgets are separate (`src/server/ingestion/rate-limit/
token-bucket.ts`):

- Blizzard: 95 req/sec sustained, 100 capacity (5% headroom below
  documented 100/s).
- WCL: 5 points/sec, 200 capacity (matches user's 18k/hr Platinum).
- Raider.IO: 4 req/sec.
- WoW Audit: 0.5 req/sec, 30 capacity (conservative; actual limits
  unknown).

## Accepted dependency advisories

These are transitive dependencies we cannot upgrade without introducing
real regressions. Each has a code-side mitigation. Recheck on every
dependency review.

1. **`nodemailer <= 8.0.4`** — SMTP command injection via attacker-
   controlled `envelope.size` / transport `name`. Pulled in by Auth.js
   v5. **Mitigation**: no user input ever reaches those fields. All
   sends use a server-controlled transport + validated User-row fields.
2. **`postcss < 8.5.10`** — CSS-stringify XSS. Pulled in by Next.
   **Mitigation**: build-time only, our own CSS files only, no user CSS.
3. **`@hono/node-server < 1.19.13`** — middleware bypass via repeated
   slashes. Pulled in by `@prisma/dev` (a Prisma 7 preview tool).
   **Mitigation**: we don't run `prisma dev` — local dev uses
   docker-compose Postgres.
