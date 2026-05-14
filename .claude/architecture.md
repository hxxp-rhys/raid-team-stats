# Architecture

## Data model (`prisma/schema.prisma`)

The non-obvious shapes:

- **`Guild`** is keyed by composite `(region, realmSlug, guildSlug, faction)`.
  Never key on name alone — "Method" exists on multiple realms across
  factions. `claimStatus` is `UNCLAIMED | GM_CLAIMED | ADMIN_CLAIMED`; only
  one user can claim a guild at a time, enforced by an atomic conditional
  `UPDATE ... WHERE claimStatus = 'UNCLAIMED'`.
- **`Character`** is keyed by stable `blizzardCharacterId` (BigInt). Realm
  slug + name is also unique but those can change (transfer / rename),
  so the Blizzard ID is the source of truth.
- **`GuildMembership`** is per-user role (`OWNER | OFFICER | MEMBER |
  PENDING`) + status (`ACTIVE | PENDING | DEPARTED`). One row per
  (user, guild).
- **`GuildCharacterLink`** is per-character history of being in a guild.
  Carries `consecutiveAbsences` for the departure-detection grace period.
- **`RaidTeam`** is a subset of a guild — the actual people who raid
  together. **Dashboards belong to raid teams, not to guilds.**
- **`RaidTeamMembership`** is soft-delete: `isActive: bool`, `removedAt`,
  `removalReason`. Departed memberships preserve history; new joins are a
  separate row.

## Three-tier sync model

This is load-bearing — every ingestion design choice flows from it.

| Tier | Cadence | Scope | Sources |
|---|---|---|---|
| **A** | Hourly (`5 * * * *` America/New_York) | Active raid-team members only | Blizzard + WCL + Raider.IO |
| **B** | Weekly Tuesday 06:00 ET | Full guild roster | Blizzard only (name/level/rank) |
| **C** | On-demand, user-triggered | Single guild | Blizzard only |

Tier C is rate-limited: 1/10min per user, 1/5min per guild.

Tier B captures the post-reset state (US weekly reset is Tuesday morning).
Vault state, tier-set counts, and weekly progress all align to that cycle.

## Departure cascade

When a sync observes a character is no longer in the guild it was
previously seen in:

1. Increment `GuildCharacterLink.consecutiveAbsences`. **Two consecutive
   misses** trigger the cascade (single API hiccup ≠ kick).
2. Mark the link `DEPARTED`, set `departedAt`.
3. Soft-deactivate every `RaidTeamMembership` for that character in this
   guild (`isActive=false`, `removalReason='guild_departure'`).
4. If this was the user's last `ACTIVE` link to the guild, flip their
   `GuildMembership.status` to `DEPARTED` (loses access to guild UI).
5. Write `AuditLog` rows for each artifact. Audit is outside the
   transaction so audit failures don't roll back the cascade.

Re-joining a guild reactivates the link to `ACTIVE` and flips the
membership to `PENDING` (admin re-approval). **Raid-team memberships do
not auto-restore** — the raid leader must re-add (intentional friction).

## RBAC

Authorization is enforced server-side in tRPC procedures via two helpers
in `src/server/api/trpc.ts`:

- `assertGuildRole(ctx, guildId, minRole)` — checks membership exists +
  status is `ACTIVE` + role ≥ minRole. Throws **`NOT_FOUND`** (not
  `FORBIDDEN`) for non-members to avoid leaking guild existence.
- `assertRaidTeamRole(ctx, raidTeamId, minRole)` — same, plus an
  override: guild OWNER/OFFICER bypasses team-level role requirements.

Role hierarchies:

- Guild: `PENDING(0) < MEMBER(1) < OFFICER(2) < OWNER(3)`
- RaidTeam: `MEMBER(0) < CO_LEADER(1) < LEADER(2)`

## Visibility

Raid teams + dashboards both have `visibility` enum `TEAM | GUILD | LINK`:

- **TEAM** — only team members + guild OWNER/OFFICER
- **GUILD** — any ACTIVE guild member
- **LINK** — anyone with a signed link (still gated to ACTIVE guild
  members — there is no public-internet exposure in v1)

Dashboard visibility cannot exceed the parent team's — the
`setVisibility` resolver caps it.

## File layout

```
src/
├── app/                       # Next.js App Router pages and API routes
│   ├── (app)/                 # authenticated app surface
│   │   ├── admin/queues/      # Phase 7: BullMQ + SyncRun triage
│   │   ├── guild/...          # guild + team + dashboard pages
│   │   └── profile/           # account, MFA, delete-account
│   ├── (auth)/                # sign-in / sign-up / verify / reset
│   ├── api/auth/[...nextauth] # Auth.js handler
│   ├── api/trpc/[trpc]        # tRPC HTTP adapter
│   ├── api/health             # liveness probe
│   ├── api/ready              # readiness probe (DB + Redis)
│   ├── bnet-login-callback/   # proxies to /api/auth/callback/battlenet
│   └── wcl-callback/          # reserved for v1.1 user-link WCL
├── proxy.ts                   # Next 16 proxy.ts (NOT middleware.ts) —
│                              # CSP nonce, security headers, IP rate-limit
├── components/
│   ├── ui/                    # shadcn primitives (Button, Card, ...)
│   └── widgets/               # 9 dashboard widget components + registry
├── lib/
│   ├── widgets/types.ts       # WidgetType, layout schemas, config map
│   ├── db.ts                  # Prisma client + token cipher extension
│   ├── redis.ts               # ioredis singletons
│   ├── logger.ts              # pino with redaction
│   ├── email.ts               # nodemailer (lazy transport)
│   ├── realm.ts               # Blizzard slug normalization
│   ├── utils.ts               # shadcn cn()
│   └── trpc-client.ts         # tRPC React client
├── server/
│   ├── auth/                  # Auth.js v5 config + MFA + tokens
│   ├── crypto/                # AES-256-GCM cipher, Argon2id KDF
│   ├── security/              # CSP, rate-limit, audit
│   ├── guild-auth/            # verify, claim, lifecycle (departure)
│   ├── ingestion/             # Blizzard / WCL / Raider.IO / WoW Audit
│   │                          # clients + BullMQ workers + schedules
│   └── api/                   # tRPC routers (auth, guild, raidTeam,
│                              # dashboard, snapshot, mfa, admin)
```

The plan's full file layout is at `~/.claude/plans/synchronous-inventing-candle.md`.
