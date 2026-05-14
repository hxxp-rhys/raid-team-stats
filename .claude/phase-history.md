# Phase history

The original plan is at `~/.claude/plans/synchronous-inventing-candle.md` —
6 phases. We've executed all 6 and one post-plan polish round.

## Phase 1 — Foundation

CSP + HSTS proxy, sliding-window rate limit, audit-log table, pino with
redaction, env validator, Docker dev stack, /api/health + /api/ready,
CI scaffolding. End-to-end smoke verified all security headers + DB +
Redis reachable.

## Phase 2 — Auth + profiles

Auth.js v5 with Credentials (Argon2id + per-email/per-IP Redis throttle)
+ Battle.net OIDC provider (link-only, not primary identity). DB
session strategy replaced with JWT because Credentials doesn't support
DB sessions cleanly. Email verification + password reset via SHA-256-
hashed tokens. Transparent OAuth token encryption via Prisma extension.

End-to-end smoke: register → verify (via dev token issuer) → sign in →
profile renders → cookie set.

## Phase 3 — Guild + RaidTeam

Composite-key Guild model. Atomic GM-claim flow (conditional
`UPDATE ... WHERE claimStatus='UNCLAIMED'`). RaidTeam as a first-class
entity owned by a Guild. GuildCharacterLink + GuildMembership with the
2-miss departure-cascade grace period. tRPC routers for guild
membership management + raid-team CRUD. UI pages for guild list, guild
detail with member approval + WoW Audit settings card, raid-team
create.

## Phase 4 — Ingestion

Snapshot tables per domain (Character / Equipment / Mplus / Raid /
Vault / WclParse) + SyncRun bookkeeping. Redis Lua token bucket with
per-job-class reservation. Blizzard / WCL / Raider.IO clients with zod
response schemas. WoW Audit client scaffold (placeholder paths/
schemas). BullMQ queues for three tiers + worker process + cron
schedules (Tier A hourly, Tier B Tuesday 06:00 ET, Tier C on-demand).
Departure cascade wired into the sync handlers.

## Phase 5 — Dashboards

`DashboardConfig` table with JSON layout. tRPC dashboard router (list /
get / create / updateLayout / setVisibility / delete) + snapshotRouter
exposing `latestForTeam` + `characterTimeline`. Nine widget primitives:
iLvL roster, M+ ladder, vault progress, gear audit, raid completion,
tier-set tracker, WCL parses, character timeline (SVG sparkline),
roster freshness. Widget registry + meta. Pages: `/guild/.../team/.../
dashboard` list + view + edit. Drag/drop reordering via @dnd-kit.

## Phase 6 — Production hardening

`docker-compose.prod.yml` (Caddy + Next + BullMQ worker + PgBouncer +
Postgres + Redis). Encrypted backup script (`pg_dump | age | rclone`).
Production deploy doc. Playwright E2E smoke wired into CI. OWASP ZAP
baseline workflow. k6 load script. MFA TOTP enrollment + sign-in
challenge + Argon2id-hashed recovery codes. GDPR account-delete with
RaidTeam-leadership precondition check.

## Phase 7 — Post-plan polish

`/admin/queues` page with BullMQ job + SyncRun triage (gated on
`ADMIN_USER_IDS`). Per-widget configuration framework with character
picker for the character-timeline widget. CSV export from the dashboard
view page (audit-spreadsheet column set).

## Deferred / blocked

| Item | Why blocked |
|---|---|
| Real Battle.net OAuth E2E | Needs a dev redirect URI registered on `develop.battle.net` + a publicly-reachable URL (tunnel) for the redirect to land. Documented in `docs/battlenet-smoke.md`. |
| WoW Audit real endpoints | User chose "scaffolding only" until real docs are in hand. Activation steps in `docs/wowaudit.md`. |
| Share-link feature | Schema visibility supports LINK; signed-token URL surface not built yet. |
| WoW Analyzer / Archon.gg | No public APIs; scraping out of scope (ToS). |
| KR / TW Battle.net regions | Plan only enabled US + EU at launch. Adding more is non-breaking. |

## Notable commits

| SHA | Message |
|---|---|
| `4b233ec` | fix(signin): read callbackUrl client-side instead of useSearchParams |
| `bdfe105` | proxy: also set CSP on request headers so Next nonces its own scripts |
| `7fc5fae` | Phase 5 UI: dashboard builder + 9 widget primitives |
| `976b271` | Phase 6 polish: MFA + delete + drag/drop + Playwright + ZAP + k6 + docs |
| `65d60e3` | Phase 3: guild + raid-team model, custom OAuth callback URLs |
| `dafab2a` | Phase 1: security baseline + foundation services |
| `1ed0e9c` | Initial commit from Create Next App |
