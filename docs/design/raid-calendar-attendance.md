# Raid Calendar & Attendance — Authoritative Design

> ## DECISIONS LOCKED (2026-06-13, by the owner)
> 1. **Build order:** Web + Discord first; the in-game **addon is deferred** to a
>    later phase — BUT with a creative **near-live outbound** model (below), not
>    the read-only-first cut.
> 2. **Push transport:** **Real SSE** — make the prod Caddy `flush_interval` +
>    `proxy.ts` matcher changes (§4.5). Short-poll remains the automatic fallback.
> 3. **Extras: ALL IN** — recurring schedules + auto-reminders (F2/F3), bench +
>    leader roster-lock (F1), attendance history signup-based (F5), and the QoL
>    set (F4 iCal, F6 set-on-behalf, F9 timezones, F15 comp templates).
> 4. **Proceed phase by phase**, checking in between phases.
>
> ### Near-live in-game signups — the creative path (addon phase)
> The platform wall is real but **asymmetric**, and only one side actually needs
> to be live:
> - **OUTBOUND (raider's own pick → website) CAN be near-live (~5–10s).** The ONLY
>   thing that flushes SavedVariables mid-session is a reload/logout — so the addon
>   **calls `C_UI.Reload()` / `ReloadUI()` itself, immediately on submit** (the
>   "Confirm/Tentative/Late/Absent" button does the reload), deferring out of
>   combat (`InCombatLockdown()` → queue until `PLAYER_REGEN_ENABLED`). The reload
>   flushes `StatSmithDB.outbox`; the watching companion (tightened to ~5–15s mtime
>   poll) uploads within seconds. End-to-end the raider's pick reaches the website
>   in ~5–10s — "near-live." The pick is shown **optimistically in-frame instantly**
>   so the reload feels like a confirmation, not a wait. Combat/queued state is
>   surfaced ("will sync when you leave combat").
> - **INBOUND (others' changes → addon) stays session-boundary** and there is **no
>   creative escape:** any SavedVariables file the addon can read is rewritten from
>   the client's in-memory copy on the next flush, clobbering a mid-session
>   companion write (verified — even a separate `StatSmithInbox.lua` the addon
>   *declares* is in the rewrite set; the only safe inbound write window is WoW
>   fully closed). For a signup board this is acceptable: the schedule is stable,
>   and the one thing that must be live (your own just-submitted status) is the
>   outbound leg, which IS near-live. The companion writes the inbound schedule
>   file only when WoW is closed → fresh at next login.
> - **Net in-game UX:** open `/ss raid`, tap a status → it shows immediately, the
>   addon auto-reloads, and within seconds the website/Discord reflect it. Seeing
>   teammates' live changes requires a `/reload` or relog (the "Refresh" button =
>   `ReloadUI`). This is the honest ceiling and is built that way in the addon phase.
>
> ---

> Status: DESIGN. Web+Discord phases now in implementation; addon phase deferred.
> Synthesizes five design-agent investigations (codebase integration, Discord
> bot, addon+companion, 3-way sync, website UX) and the adversarial-feasibility
> critique (agent F). Source-of-truth = **the website Postgres DB**. Three
> surfaces project from and write back into it: (1) Website UI, (2) Discord bot,
> (3) in-game addon (via the companion proxy).
>
> **Revision note (post-critique):** §1.3, §2, §4, §5, §6, §8, §9 and the new
> §11 were revised against the prod stack actually on `development` (pgbouncer
> transaction mode, single global `encode` Caddyfile, `globalIp` 600/60s proxy
> matcher, share-token 7–30d TTL, ingest-route ownership = character-only). The
> two prior "near-real-time both legs" claims were over-confident about infra
> that **does not exist in prod today**. See the **Critic resolution log (§11)**
> for the per-issue disposition. **Honest day-one floor is "a few seconds via
> short-poll"; SSE near-real-time is a gated follow-on, not a Phase-0 freebie.**
>
> Companion detail files (research, not in repo) live under
> `C:/Users/rhysf/AppData/Local/Temp/rts-calendar-design/{a-codebase,b-discord,c-addon,d-sync,e-ux-features,f-critique}.md`.

---

## 1. Executive summary + the hard platform truth

### 1.1 What we are building

A **per-raid-team calendar** where owners/raid-leaders schedule raids by day &
hour, optionally on a recurring weekly cadence. Each event carries an
**attendance signup**. A raider picks one of four states — **CONFIRM** (will
attend) / **TENTATIVE** / **LATE** (with an ETA) / **ABSENT** (with optional
reason) — with **NO-RESPONSE** as the implicit fifth state (the *absence* of a
signup row, derived against the roster, never persisted per non-responder).

The signup can be made from any of three surfaces, all kept convergent with the
website as the single writer/source of truth:

1. **Website UI** — calendar (month/week/agenda) + event detail with a
   role-grouped roster, comp-readiness meter, and a one-tap status control.
2. **Discord bot** — one embed per event, edited in place; one-tap state
   buttons; ETA/reason modals; per-user ephemeral ack; reminders to
   non-responders. Improves on the WoW-Audit reference embed.
3. **In-game addon** — a `CreateFrame` GUI in `StatSmith.lua` to view the
   schedule and pick a status, bridged to the network only by the desktop
   companion (`rts-companion.exe`).

### 1.2 The hard platform truth (stated plainly)

There are **three latency classes**, not two. The earlier draft said "two."
The honest taxonomy after verifying the prod stack is:

- **Website ↔ Website (multi-tab) and Website ↔ Discord are FEW-SECONDS, not
  "sub-second."** The *interaction ack* is sub-second; the **visible
  convergence** (the public Discord embed re-render, the other browser tab
  updating) is the sum of: relay poll interval + coalesce debounce + Discord
  per-channel serialization. Day one that is **a few seconds**, and it is
  delivered by **short-polling** (Phase 0) — NOT by SSE and NOT by
  `LISTEN/NOTIFY`, because neither works in the current prod topology (see
  §1.3, B1/B2). SSE upgrades the browser/companion legs to "~1–3s" but is a
  **gated follow-on phase** behind real infra changes.

- **The in-game addon is SESSION-BOUNDARY consistent, in BOTH directions —
  NOT real-time, and this cannot be engineered away.** It is a platform
  contract, verified against `warcraft.wiki.gg` and the addon source
  (`PLAYER_LOGOUT` collect L803-805, 60s ticker L800, single `StatSmithDB`
  global):
  - WoW addons have **zero network access**. The only bridge is the companion.
  - SavedVariables are a **serialize-on-unload** mechanism. The client holds the
    authoritative copy **in memory** during play and **overwrites the on-disk
    file from memory** at the next *flush*. Flush triggers are exactly:
    **logout, quit, `/reload` (`ReloadUI`), and disconnect** — and explicitly
    **NOT** periodic during play, and **NOT** on a crash/Alt-F4.
  - Therefore **outbound** (addon → site): an in-game pick lands in
    `StatSmithDB`, but only reaches disk at the next flush, and only reaches the
    server at the next companion poll after that. Honest latency: a session.
  - And **inbound** (site → addon): if the companion wrote the addon's *own*
    SavedVariables file mid-session, the client's logout overwrite would clobber
    it. The mitigation is a **separate, companion-owned, read-only inbound file**
    (`StatSmithInbox.lua`) the addon only ever *reads* at `PLAYER_LOGIN`/`/reload`,
    so it is never in the game's rewrite set. Even then the addon only sees the
    new state at the next login/`/reload`.

  **There is provably no "second SavedVariable the game never writes that the
  addon can still read while running."** The set {readable by the addon} ∩ {not
  overwritten by the game on flush} for a *running* client is empty. The only
  fully safe inbound-write window is **WoW fully closed**.

The design embraces this rather than fighting it: the in-game surface is always
"fresh as of your last login (inbound) / your last `/reload`-or-logout
(outbound)," `/reload` is offered as a user-driven **"Apply & Sync now"**, and
every in-game status shows a **pending-sync** indicator until the server
confirms it. We never promise live in-game sync.

### 1.3 Infra reality check (what the prod stack actually supports today)

Three load-bearing constraints were **verified against the live tree** and
constrain the architecture. The previous draft assumed away all three:

- **No `LISTEN/NOTIFY` wake.** Both `web` and `worker` reach Postgres **only
  through pgbouncer in `POOL_MODE: transaction`** (`docker-compose.prod.yml`
  L60/L92/L126); the `postgres` container exposes no host port and there is **no
  `DIRECT_URL`/session-mode entry** (`src/lib/db.ts` builds a single
  `PrismaPg({connectionString: env.DATABASE_URL})`; the Prisma datasource has no
  `directUrl`). Transaction pooling returns the backend to the pool after every
  TX, so a `LISTEN` subscription is silently dropped. **NOTIFY fires into the
  void.** ⇒ The relay's only reliable wake is **its own poll interval**. We
  budget **1–2s poll** as the floor and design *no* sub-second path. (Optional
  future infra: a dedicated session-mode pgbouncer DB + one pinned listener
  connection in `worker` — new env, new port exposure, new failure domain;
  explicitly out of v1, fork 9.A.10.)

- **SSE does not survive the prod Caddy + Cloudflare + proxy stack *as it
  stands*.** The prod `Caddyfile` has one global `encode zstd gzip` (L5) and one
  `reverse_proxy web:3000` with **no `flush_interval`, no per-path matcher**
  (L27-31): a `text/event-stream` body is compressed/buffered and never flushes.
  And `src/proxy.ts` runs `consumeLimit(policies.globalIp, …)` (600/60s,
  `rate-limit.ts` L128) on **every** path except `api/health|api/ready|api/metrics`
  (matcher L93) — the SSE route is *inside* the matcher, so it is rate-limited
  and CSP/nonce-processed like a page; a team of 25 browsers + companion
  reconnect storms burn the per-IP budget. **Making SSE work in prod requires
  THREE changes that are code/config, not footnotes:** (1) Caddy per-path
  matcher with `flush_interval -1` + `encode` exclusion on the stream path; (2)
  edit the `proxy.ts` matcher regex to *exclude* the stream path (a code change);
  (3) heartbeat ≤15s. Until all three land + are verified on the prod CF plan,
  **the live transport is short-polling.** (Verified: Caddyfile L5,L27-31;
  proxy.ts L40,L88-95; rate-limit.ts L128.)

- **Existing machine-auth gate is character-ownership ONLY.** The ingest route
  proves "this character belongs to the token's user" (`ingest/route.ts`
  L122-136: `character.findMany({where:{userId}})` + name/realm match) — it does
  **not** prove "this character is an active member of *the event's* RaidTeam."
  Any new write leg (the companion calendar POST) **must add an explicit
  server-side `RaidTeamMembership` check** keyed on the event's team
  (`@@unique([raidTeamId, characterId])`, `isActive` — schema L391-409), or a
  user with an off-team character can pollute another team's roster. (B4.)

### 1.4 Headline architecture decisions (the ones that matter)

1. **Hub-and-spoke with a transactional OUTBOX.** Every mutation writes the
   authoritative row **and** an append-only `SyncOutbox` row **in one Postgres
   transaction**, killing the dual-write problem. A BullMQ relay fans each
   outbox row out to three idempotent consumer adapters (Discord / companion /
   browser). At-least-once delivery + idempotent, state-convergent consumers.
2. **Clients send INTENTS, not state.** `{SET_STATUS, eventId, status,
   clientActionId}`, never "the roster is now {…}". The server applies, bumps a
   per-event/per-signup `version`, and fans out the *new authoritative state*.
3. **Last-write-wins by SERVER RECEIPT ORDER** (the `SyncOutbox.id` sequence),
   never by client clock — because the addon's effective clock is a flushed-file
   mtime that can be a whole session stale. A **per-signup** compare-and-set
   hint prevents a stale in-game action from clobbering a fresher
   Discord/website decision (the CAS counter is **`EventSignup.version`**, NOT
   `RaidEvent.version` — see §4.1 and B5).
4. **Discord = HTTP Interactions Endpoint, not a gateway bot.** Stateless,
   deploy-safe, zero-dep Ed25519 verification, no privileged intents, fits the
   existing Caddy + Cloudflare + `/uploader/*` topology. Outbound posts/edits
   are plain authenticated REST `fetch()`. **Response strategy is a single,
   non-interchangeable choice: ephemeral ack (flags=64) + async bot-token PATCH**
   — NOT `DEFERRED_UPDATE_MESSAGE` (see M1).
5. **Recurrence = series + MATERIALIZED occurrences** (rolling window, daily
   cron), not compute-on-read — because each occurrence must own a stable
   `RaidEvent.id` to hang signups, a Discord message id, an outbox stream, and a
   version off of. The materializer **also re-derives** an existing occurrence's
   `startsAt` on a tz/rule change (NOT a blind `ON CONFLICT DO NOTHING` — see M7).
6. **All new machine endpoints under `/uploader/*`, never `/api/*`** —
   Cloudflare edge-caches 404s on new `/api/*` paths pre-deploy. (One CF purge
   required after first deploy of each new path.)
7. **Live transport day one = short-polling; SSE is a gated upgrade.** Forced by
   §1.3 B1/B2. Short-poll works through the **untouched** prod stack; SSE ships
   only after the Caddy + proxy.ts + heartbeat changes are verified.

---

## 2. Architecture diagram (ASCII)

```
                         ┌───────────────────────────────────────────────┐
                         │             WEBSITE = SOURCE OF TRUTH          │
                         │                (Postgres)                      │
   client INTENT ───────►│  tRPC mutation (web) ─┐                        │
   (web / discord /      │  /uploader/intent ────┤                        │
    companion)           │                       ▼  ONE Postgres TX       │
                         │            ┌────────────────────────────────┐  │
                         │            │ RaidEvent / EventSignup         │  │  authoritative
                         │            │   (+ version, + updatedAt)      │  │  state
                         │            │ SyncOutbox (append-only,        │  │  immutable
                         │            │   id = ordering = SSE event id) │  │  event log
                         │            └───────────────┬────────────────┘  │
                         └────────────────────────────┼───────────────────┘
                                                       │  relay: BullMQ repeatable
                                                       │  POLL @1–2s (NO LISTEN/NOTIFY —
                                                       │  pgbouncer txn-mode kills it) —
                                                       │  drains PENDING FOR UPDATE SKIP LOCKED
                                ┌──────────────────────┼──────────────────────┐
                                │  sync-fanout queue (one job per outbox row)  │
                                └───────┬───────────────┬──────────────────┬──┘
                                        ▼               ▼                  ▼
                              ┌──────────────┐  ┌──────────────┐   ┌──────────────┐
                              │ DISCORD      │  │ COMPANION    │   │ BROWSER      │
                              │ adapter      │  │ adapter      │   │ adapter      │
                              │ REST PATCH   │  │ push/queue   │   │ marks team   │
                              │ embed msg    │  │ (SSE if up,  │   │ "dirty"; web │
                              │              │  │  else poll)  │   │ poll reads it│
                              └──────┬───────┘  └──────┬───────┘   └──────┬───────┘
                                     │ cursor:         │ cursor:          │ DAY-1: short-poll
                                     │ discordMessageId│ DeliveryCursor   │ GET /uploader/poll
                                     ▼                 ▼                  │ (returns rows >
                          ┌────────────────┐  ┌────────────────┐         │  client cursor)
                          │ DISCORD        │  │ rts-companion  │         │ LATER (gated):
                          │ channel embed  │  │  .exe (PC)     │         │ SSE /uploader/
                          │ (edited in     │  │     │ writes     │       │  stream/team/:id
                          │  place)        │  │     ▼ inbound SV │ ┌─────▼──────────┐
                          │   ▲ buttons /  │  │  StatSmithInbox  │ │ open calendar  │
                          │   │ selects /  │  │   .lua (R/O,     │ │ tab (web UI)   │
                          │   │ modals     │  │   companion-owned│ │  updates live  │
                          └───┼────────────┘  │   written ONLY   │ └────────────────┘
                              │ interaction   │   when WoW closed)│
                              │ (Ed25519,     │     │             │
                              │  RAW body)    │     ▼ session     │
                              ▼               │  ADDON in WoW      │
                   /uploader/discord/         │  (StatSmithDB in   │
                     interactions  ───────────┘   memory; reads    │
                   (ephemeral ack <3s,             Inbox at login;  │
                    POST INTENT back to TX)        writes outbox to │
                                                   StatSmithDB,     │
                              addon outbox  ◄───── flush @logout/   │
                              /uploader/calendar    /reload, then   │
                              (companion uploads ───┘ companion     │
                               after flush;      ───► back to the TX │
                               MEMBERSHIP-GATED) ───► (B4 gate)     │

  LEGEND:  ──► push/REST   ◄── intent in
  DAY-1 live transport = SHORT-POLL through the untouched stack (a few seconds).
  SSE = gated upgrade (needs Caddy flush_interval + proxy.ts matcher edit + heartbeat ≤15s).
  Reminders (out-of-app nudges) = separate BullMQ delayed jobs → Discord ping / email / Web Push.
  NEW long-lived service is NOT required for Discord (HTTP endpoint lives in `web`);
  the existing `worker` service runs the relay, fan-out, materializer, and reminders.
```

**Why hub-and-spoke over peer-to-peer:** 3 surfaces = 6 directed sync paths in a
mesh, each needing its own conflict logic, with no global ordering → split-brain.
The addon *cannot initiate* (no network), so a mesh is structurally impossible
for one of the three nodes. A single writer with one version and one ordering,
fanning out to dumb idempotent consumers, is the only topology that fits.

---

## 3. Data model (Prisma)

All models are **additive** (new tables + new enum values only; no destructive
changes to existing models). Reuses existing conventions: `cuid()` ids, the
`RaidTeam`/`RaidTeamMembership`/`Character`/`Account` graph, the `AuditEvent`
enum, and the `refreshSchedule` JSON-recurrence shape precedent.

### 3.1 Enums (new)

```prisma
enum AttendanceState {
  CONFIRM
  TENTATIVE
  LATE
  ABSENT
  // NO_RESPONSE is intentionally NOT a value — it is the absence of a row.
}

enum SignupSource {
  WEBSITE
  DISCORD
  ADDON
  LEADER      // a leader set someone else's status on their behalf
}

enum RaidEventStatus {
  PLANNED
  LOCKED      // roster locked / final selection made
  CANCELLED
}

enum RosterSelection {   // optional F1 — leader's final pick layer
  STARTER
  BENCH
  CUT
}

enum OutboxStatus {
  PENDING
  DISPATCHED
}
```

Extend the existing `AuditEvent` enum (additive) with:
`CALENDAR_EVENT_CREATED`, `CALENDAR_EVENT_UPDATED`, `CALENDAR_EVENT_CANCELLED`,
`CALENDAR_SIGNUP_CHANGED`, `CALENDAR_ROSTER_LOCKED`, `DISCORD_ACCOUNT_LINKED`,
`DISCORD_ACCOUNT_UNLINKED`. (`SYNC_TRIGGERED` / `SYNC_FAILED` already exist —
reuse for relay/fan-out ops.)

### 3.2 Recurrence series

```prisma
model RaidEventSeries {
  id          String   @id @default(cuid())
  raidTeamId  String
  title       String
  difficulty  String                       // "Mythic" | "Heroic" | "Normal" | "LFR"
  byday       String[]                      // RFC5545 BYDAY, e.g. ["TU","WE"]
  startLocal  String                        // wall-clock "19:00" in `timezone`
  durationMin Int                           // 180 — end computed per occurrence (DST-stable)
  timezone    String                        // IANA, e.g. "Europe/London" — NEVER a fixed offset
  rrule       String?                       // optional raw RRULE for interop/power users
  startsOn    DateTime?
  endsOn      DateTime?                      // null = open-ended; materializer caps to window
  notes       String?                       // markdown, inherited by occurrences
  createdByUserId String?
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  raidTeam    RaidTeam    @relation(fields: [raidTeamId], references: [id], onDelete: Cascade)
  events      RaidEvent[]

  @@index([raidTeamId, isActive])
}
```

> Store **local wall-clock + IANA timezone**, NOT a UTC offset, so a 19:00 raid
> stays 19:00 *local* across DST transitions. `timezone` also lives on
> `RaidTeam` as the team default; a series may override it.

### 3.3 Concrete occurrence + signups

```prisma
model RaidEvent {
  id           String          @id @default(cuid())
  raidTeamId   String
  seriesId     String?                          // null = one-off
  title        String
  difficulty   String
  raidSize     Int?                             // Mythic-Flex 15–25 (optional)
  startsAt     DateTime        @db.Timestamptz   // resolved instant (UTC) — sort/display/conflict
  durationMin  Int
  timezone     String                           // resolved-from tz (so DST changes can re-derive)
  localTime    String                           // "19:00" wall-clock the occurrence was derived from
  occurrenceDate String                         // "2026-06-16" local date — STABLE re-derive key (see M7)
  notes        String?                          // markdown
  status       RaidEventStatus @default(PLANNED)
  rosterLockedAt DateTime?
  createdByUserId String?

  // Per-surface delivery linkage (edit-in-place)
  discordGuildId   String?
  discordChannelId String?
  discordMessageId String?                       // self-healing: re-post + re-store on 404
  discordRepostLock String?                      // single-flight guard for re-post (see M3)

  version      Int             @default(0)       // monotonic per-event; bumped on any change
  createdAt    DateTime        @default(now())
  updatedAt    DateTime        @updatedAt

  raidTeam     RaidTeam         @relation(fields: [raidTeamId], references: [id], onDelete: Cascade)
  series       RaidEventSeries? @relation(fields: [seriesId], references: [id], onDelete: SetNull)
  signups      EventSignup[]

  @@unique([seriesId, occurrenceDate])           // STABLE materialization key (NOT startsAt — see M7)
  @@index([raidTeamId, startsAt])                // calendar range queries
  @@index([startsAt])
}

model EventSignup {
  id           String          @id @default(cuid())
  raidEventId  String
  userId       String                            // resolved actor (always known)
  characterId  String                            // REQUIRED — primary char by default (see m3/B5)
  state        AttendanceState
  etaMinutes   Int?                              // LATE
  reason       String?                           // ABSENT/TENTATIVE optional reason
  comment      String?
  selection    RosterSelection?                  // optional F1 leader final-pick
  source       SignupSource
  updatedByUserId String?                        // self, or leader id if source=LEADER
  version      Int             @default(0)       // per-signup monotonic — THE CAS counter (B5)
  createdAt    DateTime        @default(now())
  updatedAt    DateTime        @updatedAt

  event        RaidEvent  @relation(fields: [raidEventId], references: [id], onDelete: Cascade)

  @@unique([raidEventId, characterId])           // one signup per character-slot (no NULL hole — m3)
  @@index([raidEventId, state])
  @@index([userId])
}
```

> **`characterId` is REQUIRED, not nullable (m3/B5 fix).** A signup always
> resolves to a concrete character — default to the caller's primary membership
> character; multi-char users pick. This closes the Postgres "multiple NULLs are
> distinct" hole that would have let one user create unlimited duplicate rows
> per event and broken the dedup the whole idempotency story rests on.
> `userId` is always set for attribution/auth. NO_RESPONSE is derived = active
> membership with no row. **Role grouping (Tank/Heal/Melee/Ranged)** is derived
> from `Character.classId` + spec (spec lives on `CharacterSnapshot.specName` /
> addon, not on `Character`) via a spec→role map shared with the website widgets.
>
> **`EventSignup.version` is the CAS counter (B5).** The addon authors against
> *this* per-(event, character) counter, never `RaidEvent.version` (which bumps
> on any raider's change and would over-reject the player's own valid pick). The
> inbound file therefore ships, per event, the player's own `signupVersion` (see
> §6.2).
>
> **`occurrenceDate` (M7).** The materialization unique key is `(seriesId,
> occurrenceDate)` — the *local calendar date*, which is **stable across a DST/tz
> rule change**, NOT `startsAt` (the resolved UTC instant, which moves when the
> rule moves). This lets the materializer re-derive `startsAt` in place on a
> rule change instead of inserting a duplicate occurrence at the new instant.

### 3.4 Sync infrastructure (outbox, dedup, cursors)

```prisma
model SyncOutbox {
  id            BigInt       @id @default(autoincrement())  // ordering AND the poll/SSE event id
  raidTeamId    String
  raidEventId   String?
  kind          String                                      // "event.created"|"event.updated"|
                                                            // "event.cancelled"|"signup.changed"
  payload       Json                                        // full new authoritative state slice
  version       Int                                         // the event/signup version this carries
  idempotencyKey String
  status        OutboxStatus @default(PENDING)
  createdAt     DateTime     @default(now())

  @@index([status, id])                                     // relay drain
  @@index([raidTeamId, id])                                 // per-team replay by cursor (poll + SSE)
}

model ProcessedIntent {
  idempotencyKey String   @id                                // sha256(userId:eventId:clientActionId)
  raidEventId    String?
  userId         String?
  version        Int?
  processedAt    DateTime @default(now())
}

model DeliveryCursor {
  id           String   @id @default(cuid())
  consumer     String                                       // "discord" | "companion:<userId>"
                                                            // (NO per-browser-session rows — see m2)
  raidTeamId   String
  lastOutboxId BigInt   @default(0)
  updatedAt    DateTime @updatedAt

  @@unique([consumer, raidTeamId])
}
```

> **`DeliveryCursor` is ONLY for `discord` and `companion:<userId>` (bounded
> consumers).** Browsers do NOT get a persisted cursor row (m2 fix): a browser
> tab is ephemeral and unbounded, so a per-`sessionId` row would leak forever.
> The browser carries its cursor **client-side** — it sends `?since=<lastId>` on
> each short-poll (and `Last-Event-ID` when SSE is enabled). The server is
> stateless w.r.t. browser cursors; it just returns `SyncOutbox` rows for the
> team with `id > since` (capped to the retention window; first response on a
> cold/over-retention cursor = current full team state so the client converges).

### 3.5 Per-team Discord integration

```prisma
model DiscordIntegration {
  id            String   @id @default(cuid())
  raidTeamId    String   @unique
  guildId       String                                       // Discord guild (snowflake)
  channelId     String                                       // where embeds post
  reminderLeadsMinutes Int[]  @default([1440, 240])          // multi-shot: day-before + 4h (see m5)
  reminderMode  String   @default("CHANNEL")                 // "CHANNEL" | "DM"
  classEmojiMap Json?                                        // app-emoji ids for class icons
  installedByUserId String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
```

> **`reminderLeadsMinutes` is `Int[]` (m5 fix)** so a team can have both a
> day-before and an hour-before nudge — F2 sells "T-minus N hours" plural;
> a single int under-delivered it. Default `[1440, 240]` (24h + 4h).
>
> **Discord user ↔ site account uses the EXISTING `Account` model for the
> *binding*, but the *link handshake* needs a NEW token type (see §5.3 / B3).**
> A completed link writes an `Account(provider="discord",
> providerAccountId=<snowflake>)` row, reusing `@@unique([provider,
> providerAccountId])`, the encrypted-token Prisma extension, the existing
> linkAccount audit event, and `getUserByAccount`. No bespoke `DiscordUserLink`
> table for the *binding*. (Discord → site user = `Account where
> provider='discord' AND providerAccountId=<snowflake>`.)

### 3.6 Discord link-code (NEW — share-token is the wrong primitive, B3)

```prisma
model DiscordLinkCode {
  code        String   @id                       // short, single-use, e.g. 8 base32 chars
  userId      String                             // the site user requesting the link
  consumedAt  DateTime?                          // burn-on-use (replay-proof)
  expiresAt   DateTime                           // SHORT TTL — 10 minutes, NOT 7–30 days
  createdAt   DateTime @default(now())

  @@index([userId])
  @@index([expiresAt])
}
```

> **Why a new table and NOT `share-token.ts` (B3).** The existing share token has
> `DEFAULT_TTL_DAYS = 7`, `MAX_TTL_DAYS = 30`, **no sub-day option**, a payload
> of `{d:dashboardId, r:raidTeamId, e}` with **no user-id field**, and its only
> revocation is "rotate `AUTH_SECRET`" (kills every session + share link
> globally). Reusing it verbatim would mean a leaked link code valid for up to 30
> days that *cannot even express* "bind snowflake X to user Y" and cannot be
> individually revoked. The link code is therefore a **distinct primitive**:
> server-issued, **10-minute TTL**, **single-use** (`consumedAt` burn so a
> replayed code can't relink), user-scoped. The code itself can still be a
> stateless HMAC for tamper-evidence, but the **burn requires a DB row** —
> identity binding is too sensitive to be a pure capability. (Verified:
> share-token.ts L33-34 TTL, L36-40 payload has d/r/e no u, L16-18 revocation.)

### 3.7 Addon / companion channel

> **No new tables for the addon leg.** The companion authenticates with the
> existing **hashed bearer upload token** (`User.uploadToken`, resolved via
> `resolveUploadTokenUserId`). The in-game outbound signups ride a new
> `/uploader/calendar` POST; inbound state is pulled/pushed over the companion
> stream and written to the companion-owned `StatSmithInbox.lua`. Optionally
> reuse the `AddonUpload` precedent row if a per-character "last in-game sync"
> stamp is wanted for the website's "in-game sync connected" dot.
>
> **The `/uploader/calendar` leg MUST add a membership gate (B4).** The token
> proves only character-ownership (ingest-route precedent). Each upserted signup
> must additionally pass `RaidTeamMembership.findFirst({ where: { raidTeamId:
> event.raidTeamId, characterId, isActive: true } })` — server-side, on every
> signup in the batch — or an off-team character can pollute the roster.

### 3.8 RaidTeam additive fields

`timezone String? @default("UTC")` (team home tz, series default), and an
optional comp-template JSON (F15) reusing the `refreshSchedule` Json convention,
e.g. `{ tanks: 2, healers: 5, melee: 7, ranged: 6 }`.

---

## 4. Sync protocol

### 4.1 Core rules

- **Intents, not state.** A signup is `{type:"SET_STATUS", eventId, status,
  etaMinutes?, reason?, characterId, clientActionId}` (`characterId` always
  resolved before send). The server applies it, bumps `version`, writes the
  outbox row, fans out the new authoritative slice. Three clients editing
  different signups never overwrite each other.
- **Idempotency.** `idempotencyKey = sha256(userId:eventId:clientActionId)`.
  Apply via `INSERT ProcessedIntent ... ON CONFLICT (idempotencyKey) DO
  NOTHING`; 0 rows inserted ⇒ already applied ⇒ return current state, write NO
  new outbox row. A re-uploaded addon outbox (mtime jitter / companion retry) is
  a no-op. The signup upsert is keyed `(raidEventId, characterId)` — **both
  non-null** (m3) — so even duplicate Confirms are idempotent by construction.
- **Ordering / LWW by server receipt.** Authoritative order = `SyncOutbox.id`
  sequence. Client clocks are ignored. A Discord ABSENT received at 19:00 beats
  an addon CONFIRM the companion uploads at 19:05 *even though the addon action
  was authored at 18:00 last login* — the most recent **human decision the
  server can trust** wins.
- **Compare-and-set for stale addon actions — keyed on `EventSignup.version`
  (B5 fix).** Each addon intent carries `authoredAtSignupVersion`: the
  **per-(event, character) signup version** the addon last saw from the inbox
  file (§6.2). On ingest, if the current `EventSignup.version` for that
  `(event, character)` > `authoredAtSignupVersion`, a newer authoritative
  decision exists for **this player's own signup** → **reject the stale apply**
  (no version bump, no regression fan-out) and push current state back down to
  the companion so the in-game file self-corrects ("updated from Discord"). The
  CAS deliberately does **NOT** use `RaidEvent.version`: that counter bumps when
  *any* raider signs up, so authoring against it would falsely reject the
  player's own legitimate, newer-than-server pick. A brand-new signup
  (no row yet) authors against version `-1`/absent and always applies. Idempotency
  handles *exact* duplicates; CAS handles *stale* ones.
- **Reject signups for past events (M6).** On `/uploader/calendar` and
  `/uploader/intent`, if `event.startsAt + durationMin < now` (the raid is
  over), **reject** the intent with an ack so the companion prunes the outbox
  entry. Prevents a days-late companion flush from resurrecting a CONFIRM on a
  finished raid and corrupting the "signed CONFIRM but observed absent" ledger
  signal. A configurable grace (default: reject after `startsAt + durationMin`)
  bounds outbound staleness; the companion drops any outbox entry whose event is
  unknown/past on the server's ack.
- **Delivery guarantee = at-least-once + idempotent, state-convergent
  consumers.** Not exactly-once on the wire, but exactly-once-equivalent in
  user-visible outcome because every consumer converges to *current state keyed
  by version*. A dropped Discord edit is healed by the next render; a 20-minute
  Discord outage costs ONE catch-up PATCH (read current state, not replay the
  log).

### 4.2 Outbox relay + fan-out

- **Relay** (BullMQ repeatable, **1–2s poll** — there is **NO** `LISTEN/NOTIFY`
  wake; §1.3 B1): `SELECT … WHERE status='PENDING' ORDER BY id FOR UPDATE SKIP
  LOCKED`, enqueue one `sync-fanout` job per row, mark `DISPATCHED`. `SKIP
  LOCKED` makes multiple relays safe. **Polling relay, NOT CDC/Debezium** — we
  already run BullMQ; Kafka Connect is a moving part we don't want. The 1–2s poll
  IS the floor; nothing is sub-second except the interaction ack itself.
- **Fan-out worker** (mirrors the existing `worker.ts` fan-out template):
  per-row, dispatches three independent consumer jobs (Discord / companion /
  browser-dirty-mark). One consumer failing does not block the others or later
  rows. A poison row exhausts `attempts` → BullMQ failed set + `SYNC_FAILED`
  audit, while later full-state pushes supersede it (consumers are
  state-convergent, not log-replay).
- **Reuse** `queues.ts` `defaultJobOptions` (attempts:3, exponential backoff,
  removeOnComplete). Give Discord delivery more attempts + jitter (external).
  JobIds use `_` not `:` (BullMQ rejects `:`).

### 4.3 The six directional legs (exactly how each works)

| # | Leg | Mechanism | Latency (day 1) | RT? |
|---|-----|-----------|-----------------|-----|
| 1 | **web → server** | tRPC mutation (`protectedProcedure`, `assertRaidTeamRole`) writes state+outbox in one TX | ms | yes |
| 2 | **server → web** | **Short-poll** `GET /uploader/poll/team/:id?since=<lastId>` (cookie auth) returns outbox rows > cursor; client polls ~3–5s. **SSE is the gated upgrade** once Caddy + proxy.ts changed (§1.3 B2) | **a few seconds** (poll); ~1–3s (SSE later) | partial |
| 3 | **discord → server** | Interaction → `/uploader/discord/interactions` (Ed25519 over **raw body** — m6) → **ephemeral ACK type 4, flags=64** in <3s → POST INTENT to `/uploader/intent` → same TX | sub-second to ack; embed via leg 4 | yes (ack) |
| 4 | **server → discord** | Fan-out Discord adapter `PATCH /channels/{ch}/messages/{id}` (**bot token**) re-renders embed from current DB state; per-channel serialized + coalesced (§5.4) | relay-poll + debounce + serialize = **a few seconds** | no (few-s) |
| 5 | **addon → server** | In-game pick → append to `StatSmithDB.outbox` → flush at `/reload`/logout → companion mtime-watch reads new entries → POST `/uploader/calendar` (**membership-gated B4**, **past-event-rejected M6**, **per-signup CAS B5**) → same TX | **session boundary** | **no** |
| 6 | **server → addon** | Fan-out companion adapter pushes to companion (SSE if up, else companion polls) → companion writes `StatSmithInbox.lua` **only when WoW closed** → addon reads at next `PLAYER_LOGIN`/`/reload` | **session boundary** | **no** |

> Legs 5 & 6 are the honest session-boundary legs. `/reload` ("Apply & Sync
> now") collapses the outbound lag to "a few seconds after the reload," which is
> the best achievable and what the GUI advertises. **Leg 2 is short-poll day one
> — "a few seconds," not "seconds-and-live"** (m1). The public Discord embed (leg
> 4) is never sub-second; the ack is.

### 4.4 Recurrence materialization (DST-safe, M7-corrected)

A `event-materialize` repeatable BullMQ job (daily ~04:00, plus on series
create/edit) maintains concrete `RaidEvent` rows for a rolling window (default
**8 weeks**) per active `RaidEventSeries`. Each occurrence's instant is computed
by interpreting `startLocal` in `timezone` on `occurrenceDate` through the IANA
tz DB (DST-correct).

**The upsert key is `(seriesId, occurrenceDate)` — the stable local date — NOT
`startsAt` (M7 fix).** This matters: if the upsert keyed on `startsAt` with `ON
CONFLICT DO NOTHING` (the prior draft), a tz/rule change would compute a *new*
`startsAt`, miss the existing row (different key), and **insert a duplicate
occurrence** at the new instant — two events, two Discord messages, split
signups. Keying on the local date, the materializer:

1. Upserts the row for each `(seriesId, occurrenceDate)` in the window.
2. **On every run, re-derives `startsAt` from `(localTime, timezone,
   occurrenceDate)` and UPDATES it if it changed** (IANA tz DB update or a
   series `timezone` edit). Signups + the Discord message id stay attached to the
   same row (they hang off `RaidEvent.id`, which is unchanged). The re-derive
   bumps `version` and fans out an `event.updated` so all surfaces re-render the
   corrected time.
3. A series `timezone` or `localTime` edit triggers an immediate re-materialize
   that re-derives all future occurrences in place.

This mirrors the existing `team-schedule-sweeper` 5-min sweep +
`RaidTeam.refreshSchedule` convention. Per-instance edits/cancels mutate the
single materialized row; "this and future" edits update the series +
re-materialize forward.

### 4.5 Push transports + Caddy/Cloudflare traversal

**Day-one transport is SHORT-POLL (works through the untouched prod stack).
SSE is a gated upgrade (§1.3 B2).**

- **Browser, DAY 1 = short-poll.** `GET /uploader/poll/team/:id?since=<lastId>`
  (cookie auth), client polls every ~3–5s while the calendar tab is focused
  (back off when hidden). Returns `SyncOutbox` rows for the team with `id >
  since`; the client advances its own cursor. **No persisted server cursor**
  (m2). First response on a cold/over-retention cursor = current full team state.
  This needs **zero** Caddy/proxy change and is correct through Cloudflare.
- **Browser, LATER (gated) = SSE.** `/uploader/stream/team/:id`, cookie auth,
  `Last-Event-ID` reconnection = the same cursor mechanism. Ships **only after**
  all three prerequisites land and are verified on the prod CF plan:
  1. **Caddy:** a per-path matcher for the stream route with `reverse_proxy {
     flush_interval -1 }`, **excluded from the global `encode`** (else the
     `text/event-stream` body buffers/compresses and never flushes — the stream
     looks dead). The prod Caddyfile today has neither (L5 global encode, L27-31
     single proxy, no matcher).
  2. **proxy.ts:** **edit the `matcher` regex** (L93) to add the stream path to
     the exclusion list alongside `api/health|api/ready|api/metrics`, so a held
     SSE connection is not run through `consumeLimit(policies.globalIp)`
     (600/60s) or CSP/nonce processing. **This is a code change, not a Caddy
     footnote**, and is a prerequisite task of the SSE phase.
  3. **Heartbeat ≤15s** (`:keep-alive` comment line) — the CF Free/Pro idle
     cutoff clusters ~100s in real-world reports (U2); ≤15s is well under both
     that and the documented ~400s. Plus `Cache-Control: no-cache, no-transform`,
     `X-Accel-Buffering: no`, `Content-Type: text/event-stream`.
  - **Why not WebSocket:** no client→server streaming need; SSE's native replay
    is the feature we'd otherwise reimplement. **Why not Web Push as the live
    channel:** unreliable for in-page updates, no ordering, no replay — Web Push
    is **out-of-app nudges only**.
- **Companion, DAY 1 = poll; LATER = SSE.** Day one the companion polls
  `GET /uploader/calendar/poll?since=<cursor>` (bearer `uploadToken`) on the same
  ~5–15s cadence it already uses, persisting its cursor to disk. The SSE upgrade
  (`/uploader/stream/companion`) rides the same three prerequisites as the
  browser SSE; a ~40-line zero-dep SSE reader keeps the companion zero-dep,
  exponential backoff (1s→30s, full jitter) on disconnect, resend cursor. A held
  connection (once SSE is on) also powers the website's green "in-game sync
  connected" dot; until then the dot reflects "last poll within N minutes."
  **The companion stream/poll streams ONLY the token-user's own status +
  aggregate counts — never other raiders' identities/states (M5).**
- **Cloudflare/Caddy survival** for the SSE phase is the three-item checklist
  above; all under `/uploader/*` (never `/api/*`); CF purge once after first
  deploy of each new path.

---

## 5. Discord bot

### 5.1 Service shape — HTTP Interactions Endpoint (RECOMMENDED), not a gateway bot

**Decision: HTTP Interactions Endpoint URL + outbound REST (bot token). No
gateway WebSocket, no `discord.js`.**

- Discord delivers interactions one of two mutually-exclusive ways: gateway
  WebSocket, or **HTTP outgoing webhook** (the Interactions Endpoint URL). A bot
  can **send and edit messages purely over REST** with the bot token — the
  gateway only adds *receiving* real-time events (MessageCreate, presence,
  voice), **none of which we need**.
- Our entire feature is: post one embed/event, edit it in place, receive
  button/select/modal interactions. Posts+edits are outbound REST; interactions
  are exactly what the endpoint delivers.
- **Wins for this stack:** stateless (no RESUME/IDENTIFY/zombie-socket/shard
  math); a `next build` redeploy or container bounce **drops zero events**
  (Discord re-POSTs, users re-tap); it's just one more Next route handler in the
  `/uploader/*` family (`/uploader/discord/interactions`); outbound posts/edits/
  reminders are plain `fetch()` from the tRPC mutation, the worker, and the
  interaction handler alike. **No new always-on container.**
- **Ed25519 verification over the RAW request body (m6, load-bearing).** Verify
  `X-Signature-Ed25519` + `X-Signature-Timestamp` over `timestamp || rawBody`
  with the app public key via Node `crypto.verify("ed25519", …)` — zero-dep,
  matches the companion ethos. **You MUST read `await req.text()` (raw) and NOT
  `await req.json()`** — a JSON re-serialization changes the bytes and the
  signature fails. (The ingest route's `req.text()` → `JSON.parse` is the exact
  shape to copy.) PING(1)→PONG(1). Verification is **load-bearing for auth** (we
  trust the signed `member.user.id`), not just for endpoint registration; a
  non-verifying request → 401 (Discord's routine invalid-signature probes expect
  this and must not count as an outage).
- **No privileged intents** (no Message Content) — sidesteps Discord's privileged-
  intent verification gate entirely.

### 5.2 The improved embed + interaction UX

WoW-Audit baseline: one edited-in-place embed; a single "Set your status" SELECT
(two taps); role-grouped roster w/ green checks + class icons; an "Unknown (N)"
3-column blob; footer "3/23 available"; Refresh / Web page / View selections /
Comment buttons; "(edited)". **Our improvements:**

1. **Four one-tap state BUTTONS** (row 1) instead of a select: ✅ Confirm
   (green), 🟡 Tentative (grey), 🕒 Late (blurple → ETA modal), ❌ Absent (red →
   optional-reason modal). One tap = done for the common case.
2. **ETA modal for LATE** (`MODAL` type 9 opens instantly = a valid <3s
   response): "How late? (e.g. '20 min', '21:30')". Renders "🕒 Late ~20m".
3. **Optional reason for ABSENT** (modal). Empty = plain Absent. Reason visible
   to leaders (configurable).
4. **Role-segmented comp-readiness line** — `Tanks 2/2 · Healers 4/5 · DPS 14/16
   · 20/23 confirmed` — the single biggest at-a-glance win vs flat "3/23".
5. **Roster grouped by role with per-name state glyphs** (✅🟡🕒❌⬜), class-
   colored, class icons via custom app emoji (`<:name:id>`, unicode fallback).
6. **Per-user EPHEMERAL ack** (flags=64) on every action — confirms receipt
   without channel spam; only the shared embed edit is public.
7. **Notes thread** (💬) — first tap starts a thread off the event message;
   later taps deep-link. Keeps "swapping prot→resto" out of the embed.
8. **Utility row:** 🔄 Refresh (ephemeral), 🔗 Web page (link button, no handler),
   💬 Notes. Drop "View selections" (roster already shows every state inline).
9. **Reminders to NON-RESPONDERS** at the configured leads (default 24h + 4h):
   **a single non-`@`-spam reminder that links to the embed** (default), or DM
   (falls back to channel link on closed-DM 403); per-user opt-out. **NOT a
   second button-bearing message and NOT a 15-20-person `@`-ping** (see M4).

**State authority + RESPONSE STRATEGY (M1 — single non-interchangeable choice):**
Discord stores nothing authoritative. **Every tap → respond with an EPHEMERAL
acknowledgement (type 4 message, flags=64) in <3s** (or a MODAL for Late/Absent,
which is itself a valid <3s response), → POST to `/uploader/intent` → DB upsert
→ the **public embed is re-rendered later by the worker fan-out via a bot-token
`PATCH /channels/{ch}/messages/{id}`**.

> **Do NOT use `DEFERRED_UPDATE_MESSAGE` (type 6) (M1).** A type-6 deferred-update
> ack tells the user's client "I will edit *this* component message via the
> interaction token" — but we edit it later via a *separate bot-token PATCH from
> the worker*, never via the interaction token. If the worker is backed up
> (coalescing, retry backoff), the interaction token lapses (15-min validity)
> with no follow-up and the user's client resolves the spinner to **"This
> interaction failed."** The ephemeral-ack path decouples the public embed edit
> from the interaction token entirely: the ack is instant and self-contained, the
> embed edit is async and bot-token-driven, and no spinner is ever left hanging.
> The bot does **not** edit the embed from the interaction itself (that would be a
> second writer). Discord can never diverge from the SoT.

### 5.3 Linking Discord user → site account

Support both; lead with the link-code for cold-start, OAuth for convenience.

- **One-time `/statsmith link code:<CODE>` (cold-start, RECOMMENDED primary).**
  Uses the **new `DiscordLinkCode` primitive (§3.6 / B3), NOT `share-token.ts`.**
  10-minute TTL, single-use (`consumedAt` burn so a replayed code can't relink),
  user-scoped. Site shows a code; `/statsmith link code:<CODE>` reads the
  **signed** `member.user.id`, validates the code (unexpired + unconsumed),
  atomically burns it, and writes the `Account(provider="discord")` row. **No new
  public OAuth path** → avoids the CF-404 trap. Individually revocable (delete the
  row / let it expire) without touching `AUTH_SECRET`.
- **OAuth2 (`identify` scope) via Auth.js v5** — adds the Discord provider the
  same way Battle.net is wired; "Connect Discord" in account settings writes the
  `Account(provider="discord")` row. **Trade-off:** the OAuth callback is a new
  public path; if routed via a `/discord-callback` proxy it is CF-404-prone
  pre-purge.
- **Mapping:** Discord snowflake → `Account` → `User` → `Character[]` →
  `RaidTeamMembership[]`. For the event's team, find the caller's active
  membership; multi-char users get a character-picker select (default primary).
  Unlinked interaction → ephemeral "Link your Stat Smith account first" + link
  button. **Never guess identity; never trust Discord guild roles for authz** —
  re-check `RaidTeamMembership.role` server-side against the linked account.

### 5.4 Rate-limit & coalescing strategy

Verified limits: global **50 req/s** per bot (interaction *responses* exempt);
per-resource buckets keyed `channel_id`/`guild_id`/`webhook_id`; **message PATCH
budget is dynamic and per-route — the community-cited "~5 edits/channel/~5s" is a
DESIGN BUDGET, not a contract (U1/M2)**; 10k invalid (401/403/429)/10min → temp
CF IP ban (`shared`-scope 429s exempt); **always honor `Retry-After` as the
only authoritative limit.**

**Strategy — per-CHANNEL serialized + coalesced + single-flight in Redis** (in
the worker, not the request path):
1. Button tap = instant ephemeral ACK (exempt) + DB upsert + enqueue "re-render
   event E". Public embed edit is eventually-consistent (a few seconds) — fine
   for a signup board.
2. **Coalesce per event message**: `discord:render:dirty:<eventId>` + a 1.5–2s
   debounce; on fire, render ONCE from current DB state. N taps in a 2s burst =
   **1 edit**.
3. **Single-flight render lock**: `discord:render:lock:<eventId>` — one in-flight
   PATCH per event; taps mid-PATCH re-mark dirty for one more render.
4. **CHANNEL-LEVEL serialization across events (M2 fix — load-bearing).** The
   rate-limit bucket is keyed on `channel_id`, and a team posts Tue/Wed/Thu
   events to **one** `#raid-signups` channel. When the leader posts the week and
   raiders sign up across all three at once, three per-event renders fire into
   **one** shared channel bucket — coalescing per-event does NOT save you. So a
   **per-channel token bucket / serial queue** (reuse `rate-limit/token-bucket.ts`
   keyed by `channel_id`) gates **all** event renders + reminders for that
   channel through one outbound lane. Worst case degrades to "renders trickle out
   over a few seconds," never a 429 storm.
5. **429** → read `Retry-After`, sleep, re-read DB at retry (never PATCH stale).
   **`Retry-After` is the contract; the 5/5s number is only a budget.**

Net: even a 30-raider, 3-event flurry into one channel produces a serialized
trickle of coalesced edits gated by the per-channel lane — bounded, never banned.

### 5.5 Self-healing on Discord message 404 (M3-corrected)

`discordGuildId + discordChannelId + discordMessageId` persist per event. If a
render `PATCH` 404s (message deleted in Discord), the adapter re-posts and
re-stores the id. **This re-post path needs its own single-flight lock distinct
from the render lock (M3):** with multiple relays (`SKIP LOCKED`) and BullMQ
retries, two fan-out jobs for the same event can both observe the 404 and both
POST → **two embeds**, one orphaned, un-editable, forever-stale, that raiders
will tap. The fix:

1. A dedicated `discord:repost:lock:<eventId>` (Redis `SET NX PX`) — only one job
   may re-post; others wait and re-read `discordMessageId`.
2. **Create-or-adopt keyed on `(channelId, eventId)`:** before posting, search
   the channel's recent bot messages for an existing embed carrying this
   `eventId` (embed footer/custom-id marker); if found, adopt its id instead of
   posting a second. `discordRepostLock` on `RaidEvent` records the in-flight
   re-post so a crash mid-re-post is recoverable.

### 5.6 Per-guild install, slash commands, intents

- **Install** (once per Discord guild by an admin): `oauth2/authorize?client_id=
  …&scope=bot+applications.commands&permissions=<INT>`. Minimal permission
  integer: View Channel + Send Messages + Embed Links + Read Message History +
  Create Public Threads + Send Messages in Threads + mention. **NOT
  Administrator (never `8`).**
- **Intents:** none (HTTP interactions need no gateway intents; explicitly no
  Message Content).
- **Slash commands** (guild-scoped, REST `PUT` on install; authz re-checked
  server-side against the linked account):
  - `/raid create day time duration difficulty team channel` — creates the event
    on the website (SoT) and posts the embed.
  - `/raid edit event …` / `/raid cancel event` (cancel → struck-through
    "CANCELLED" embed, never delete — preserves history).
  - `/raid remind event` — manual nudge.
  - `/statsmith link code:<code>` (any member) — account linking (link-code).
  - `/statsmith setup channel:<#>` (admin) — bind a team to a channel
    (`DiscordIntegration`).
  - Autocomplete (event:/team:) via the autocomplete interaction (type 4).
- **The sync linchpin:** persist `discordGuildId + discordChannelId +
  discordMessageId` per event; re-post path is single-flighted + create-or-adopt
  (§5.5).

---

## 6. Addon + companion

### 6.1 The two-way bridge (honest, session-boundary)

```
WEBSITE (SoT) ─poll/SSE (seconds)─► COMPANION (rts-companion.exe) ─file (session)─► ADDON in WoW
WEBSITE (SoT) ◄─POST (seconds after flush)─ COMPANION ◄─file (session, @flush)─ ADDON
```

- **(server → companion, fast-ish):** companion polls (day 1) or holds SSE
  (later); the schedule + the player's own status + aggregate counts arrive
  within seconds of any change. **Own status + counts only — never other
  raiders' identities/states (M5).**
- **(companion → addon file, gated):** companion writes the inbound payload into
  a **separate, companion-owned `StatSmithInbox.lua`** (declared in the TOC, but
  the addon **only ever reads** it) **only while WoW is fully closed**. WoW
  detection: **`Wow.exe` process check (primary)** + atomic temp-write+rename +
  re-stat verify (belt-and-braces). If WoW is running → stage the snapshot,
  show tray status "Schedule update queued — applies next login."
- **(addon → file outbox, gated):** in-game pick appends an idempotent entry to
  `StatSmithDB.outbox`; on disk only at the next flush.
- **(companion → server, fast):** companion mtime-watch reads new outbox entries
  after `outboxCursor`, POSTs to `/uploader/calendar`; server (a) **checks
  `RaidTeamMembership` for `(characterId, event.raidTeamId)` is active (B4)**,
  (b) **rejects events past `startsAt + durationMin` (M6)**, (c) **applies CAS on
  `EventSignup.version` (B5)**, then upserts by `(raidEventId, characterId)`,
  returns accepted+rejected `actionId`s; companion advances `outboxCursor` and
  prunes rejected/stale entries.

**Genuinely impossible (state plainly in docs/UI):** real-time in-game signup
others see in seconds *without a `/reload`/logout*; the companion pushing into a
running client's UI; the addon reacting to a server change mid-session.

### 6.2 SavedVariables shapes

```lua
StatSmithInbox = {                         -- SEPARATE FILE, companion-owned, addon READ-ONLY
  syncedAt = 1718500000, team = {...}, me = {...},
  events = { { id, title, startsAt, endsAt, difficulty,
              myStatus, myEta,
              mySignupVersion,             -- per-(event,char) EventSignup.version — the CAS input (B5)
              counts = {confirm,tentative,late,absent,unknown,total},
              eventVersion } },            -- next ~6 events; OWN status + counts only (no full roster — M5)
}
StatSmithDB.outbox = {                     -- written by addon (outbound), read by companion @flush
  { actionId, eventId, status, eta, note, charKey, createdAt,
    authoredAtSignupVersion },            -- the mySignupVersion the pick was authored against (B5)
}
StatSmithDB.outboxCursor = "<last acked actionId>"
```

> **The inbound file is `StatSmithInbox.lua` — a SEPARATE, companion-owned file
> the addon only ever READS (B5/M5/fork O6).** This removes the "companion and
> game both own this global" clobber hazard structurally and makes the
> read-only-by-addon contract enforceable by file ownership, not convention.
>
> **`mySignupVersion` is delivered per event (B5).** It is the
> `EventSignup.version` for *this player's own signup on that event*. The addon
> copies it into each outbox entry as `authoredAtSignupVersion` so the server's
> CAS compares like-for-like. `eventVersion` is carried only for display
> freshness, **never** used as the CAS input.
>
> `actionId` = `charKey:eventId:time():counter` (WoW has no UUID; counter
> persisted in `StatSmithDB`). Upsert-by-`(event, character)` newest-`createdAt`
> → duplicate POSTs are no-ops. A crash/Alt-F4 loses the unflushed outbox (no
> `ADDONS_UNLOADING`) — worst case "last in-game pick didn't upload," acceptable
> & recoverable. **Never make correctness depend on a flush happening.**

### 6.3 In-game GUI (reuse existing CreateFrame scaffolding)

StatSmith already builds a movable `BackdropTemplate`, `DIALOG`-strata frame with
a `ScrollFrame`+`EditBox` (export window, ~L674–723). Add a second
`StatSmithCalendarFrame`:
- **Title bar:** team name + "Schedule (as of <syncedAt>)" + a stale warning if
  `syncedAt` > ~24h old.
- **Per-event row:** left = day/date/time-range + difficulty/season; center =
  **Confirm / Tentative / Late / Absent** buttons (`UIPanelButtonTemplate`,
  selected one highlighted "locked-in"; Late reveals a numeric ETA `EditBox`);
  right = compact `14 ✓ · 2 ? · 1 ⏱ · 3 ✗` from `counts` + a per-event
  **pending / uploading / synced** dot.
- **Footer:** **"Apply & Sync now (reloads UI)"** = `ReloadUI()`, a "Pending: N"
  label, and the honest hint "WoW saves addon data on reload/logout — your picks
  upload then." A selectable URL `EditBox` (no in-game browser-open API) mirrors
  WoW-Audit's "Web page" honestly.
- **Slash:** `/ss raid` / `/statsmith raid` toggles the frame (extend the
  existing handler; no new SLASH globals). Bump `## Version` + `ADDON_VERSION`
  and add the **`StatSmithInbox` SavedVariables declaration** to the TOC (the
  separate inbound file requires one extra `## SavedVariables` line).

### 6.4 Honest UX for session-boundary sync

The GUI makes **no "live" claims.** Every change shows three distinguishable
states — *pending flush* (changed, not yet `/reload`), *uploading* (flushed,
companion not yet acked), *synced* (server `myStatus` == local) — and the
"Apply & Sync now = `/reload`" button is the user-driven bridge that collapses
the lag. The website/Discord show a "last seen in-game" badge so leaders read
the staleness too.

### 6.5 Companion push channel + endpoints

Extend `companion/upload.mjs` (keep zero-dep, keep the slow snapshot path
unchanged): (a) poll `/uploader/calendar/poll` day 1, SSE client to
`/uploader/stream/companion` later; (b) `Wow.exe` process check; (c) safe atomic
inbound writer that **preserves StatSmith's existing globals** — note the inbound
file is the *separate* `StatSmithInbox.lua`, so the writer owns that file
entirely (no merge into `StatSmithDB`'s `export`/`collectedAt` globals — this is
the de-risking win of the separate file); (d) outbox reader → POST
`/uploader/calendar`; (e) tighten the calendar cadence to ~5–15s mtime checks.
New server endpoints, all under `/uploader/*` with the existing bearer-token auth
+ per-token rate-limit pattern:
- `POST /uploader/calendar` — outbox upsert. **MUST: (B4) check active
  `RaidTeamMembership(characterId, event.raidTeamId)`; (M6) reject events past
  `startsAt + durationMin`; (B5) per-signup CAS.** Returns accepted+rejected
  actionIds.
- `GET /uploader/calendar/poll?since=<cursor>` — day-1 companion pull (own
  status + counts only — M5).
- `GET /uploader/stream/companion` — SSE (gated on §4.5 prerequisites; own status
  + counts only — M5).

> **Leaked-token blast radius (M5).** The upload token was scoped for a
> low-stakes write-only snapshot; the calendar elevates it to read+write
> attendance. Mitigations: (1) the poll/SSE streams **only the token-user's own
> status + aggregate counts**, never other raiders' identities/states; (2)
> `/uploader/calendar` enforces the B4 membership gate + per-(member, event)
> ownership so a leaked token cannot write *another* character's row; (3) **add
> upload-token rotation UX** (there is none today) since the blast radius grew;
> (4) the existing `uploadIngestPerToken` 40/10min cap bounds the POST leg, but a
> held SSE connection is one connection — the SSE handler must itself cap
> concurrent streams per token and per IP.

---

## 7. Website UX

Route family: a new **`/calendar`** tab inside the existing team ControlPanel
shell (`…/guild/[guildId]/team/[teamId]/`), NOT a new top-level area. Gating
reuses `assertRaidTeamRole` verbatim: **read = MEMBER**, **event create/edit =
CO_LEADER**, **recurrence + lock + delete = LEADER**; guild OWNER/OFFICER &
platform admin override.

### 7.1 Calendar (three views)

- **Month** (desktop default): 7-col grid; day chips colored by difficulty, each
  with a readiness pip (`18/23`) and the viewer's own state dot
  (green/amber/blue/red/grey). Chip → event detail panel.
- **Week**: hour-row time-grid; events as blocks with title + difficulty +
  readiness bar. The leader's planning surface.
- **Agenda** (mobile default): chronological cards (next 30 days) with date/time
  in viewer TZ, difficulty, readiness meter, and an **inline one-tap status
  control**. The lowest-friction surface most raiders use; reuses the shipped
  mobile-dashboard conventions.
- One `calendar.eventsInRange` tRPC query returns events + the viewer's own
  signup + aggregate readiness counts (no per-roster fan-out on the list — defer
  the full roster to the detail panel). A header **timezone chip** ("times shown
  in your local time — Europe/London", per-viewer override) over a team **home
  timezone**.
- **Live updates day 1 = short-poll** (§4.5): the focused calendar tab polls
  `/uploader/poll/team/:id?since=<lastId>` ~3–5s and merges new outbox slices.
  No "live forever" claim; the upgrade to SSE is transparent to this UI (same
  cursor contract).

### 7.2 Create/edit event modal

Lightbox (reuse dashboard modal). Fields: Title (default "Team S1 — Mythic");
Date + Start/End in team home TZ with a live "= your local 18:00" echo (validate
end>start, warn >6h); Difficulty (+ optional Mythic-Flex size 15–25); Notes
(markdown → detail panel + Discord embed + iCal DESCRIPTION); **Recurrence**
(LEADER: weekly on [days] + end-condition, with an "creates 8 events through …"
preview, and "this event / this and future" on instance edit); **Auto-post to
Discord** toggle (on by default if linked). Save → materialize (if recurring) +
enqueue Discord-post + audit-log.

### 7.3 Event detail panel (the headline UX win)

Two-column desktop / stacked mobile.
- **Header:** title • difficulty • "Tuesday, June 16 • 19:00–22:00 (your local:
  …)" • status pill (PLANNED/LOCKED/CANCELLED) • leader-actions menu.
- **Comp-readiness meter** (improves on "3/23"): role-segmented bar —
  Tanks/Healers/Melee/Ranged each green-when-met / amber-when-short vs a team
  comp template (leader-editable per event), plus a headline % and a "needs: 1
  healer, 1 tank" gap line.
- **Roster grouped by role then state:** Tank/Healer/Melee/Ranged columns (role
  from spec→role), each ordered Confirm → Late(+ETA) → Tentative → Bench →
  Absent(reason) → No-response (the "Unknown" group kept **role-aware**, not one
  blob). Green check on Confirm; "ETA +20m" on Late; reason on hover for Absent.
- **Your status control:** always-visible segmented `Confirm | Tentative | Late
  | Absent` (optimistic DOM, which the repo already does). Late → ETA stepper;
  Absent → optional reason; multi-char users get a character picker (default
  primary, since `characterId` is required — m3).
- **Leader controls:** "Set status for…" (on-behalf, source=LEADER, audit-
  logged), "Lock roster / Final selection" (LEADER), Cancel, Edit, "Repost to
  Discord", "Nudge non-responders".
- **Activity/edited indicator:** "updated 2m ago" + a source icon
  (web/discord/in-game) so leaders see WHERE each signup came from.

### 7.4 Attendance history (feeds the planned W6 attendance_ledger / W5 widgets)

`…/calendar/history` — two lenses:
- **Per-raider table:** character × {attendance % (window), confirmed-but-no-show
  count, late, tentative, bench, current streak, last-raided}. Window default =
  4-week rolling (matches W6); season/all-time options. The bench/retention
  screen.
- **Per-event grid** (character × night, P/L/B/N/A/U glyphs).
  - **Signup state (first-party SoT) is available in the recommended bundle.**
  - **Observed-presence (addon `RaidNightObservation`) is NOT in the recommended
    bundle (m4):** it depends on the addon observation layer, which F13 defers.
    So the headline **"signed CONFIRM but observed absent"** column ships **only
    once the observation layer lands** — the history screen renders signup-only
    until then, with the observed column shown as "needs in-game data." Do not
    market the no-show signal as deliverable in the F5-only bundle.
- **Honesty rails:** unobserved nights excluded from denominators; benched-but-
  present never scored absent; "—" until ≥4 observed nights; raiders see their
  OWN row first (transparency). Expose `calendar.attendanceLedger` so W6 is a
  thin presentation over this data, not a parallel system.

---

## 8. Build plan (phased, each independently shippable)

Project cadence per phase: **dual-validate locally** (`tsc` with `.next` cleared,
`next build`, `vitest`, `eslint` — `next build` does NOT gate eslint; CI on
`development` only runs the security scan), commit on a branch, push, and run the
**vps-deploy** runbook (a schema migration force-recreates `worker`; **purge
Cloudflare** once after any new `/uploader/*` path). After every change, `docker
compose restart web worker` before testing (Turbopack ignores host edits).

**Phase 0 — Foundation (web-only, SHORT-POLL transport).**
New: enum + model migrations (§3.2–§3.6), `calendar` tRPC router (registered in
`root.ts`), the month/week/agenda views, event CRUD modal, event detail panel +
one-tap status, the 4 base states, `SyncOutbox` write-in-TX, and the **short-poll
endpoint `GET /uploader/poll/team/:id`** (consumers otherwise stubbed). **No SSE
in Phase 0** — short-poll works through the untouched Caddy/proxy stack (B2/M8).
Migrations: all §3 tables. Env: none. Service: none new. *Shippable:* a working
website-only calendar with multi-tab convergence within a few seconds (poll).

**Phase 1 — Recurrence + reminders backbone.**
`RaidEventSeries` + `event-materialize` repeatable job (**re-derive-in-place on
tz change, keyed on `(seriesId, occurrenceDate)` — M7**); `event-reminder`
delayed jobs (email via existing SMTP first; **multi-lead `Int[]` — m5**). New
queues in `queues.ts`. Env: none. Service: none new (worker runs it).
*Shippable:* recurring weekly schedules + email reminders to non-responders.

**Phase 2 — Discord bot (the big lever).**
`/uploader/discord/interactions` route (Ed25519 over **raw body — m6**),
`/uploader/intent`, `DiscordLinkCode` model + link flow (**not share-token —
B3**), `DiscordIntegration` model + team settings "Discord" section, the improved
embed + buttons/modals (**ephemeral-ack + bot-token PATCH, NOT
DEFERRED_UPDATE_MESSAGE — M1**), `/raid` + `/statsmith` slash commands, the
`sync-fanout` Discord adapter with **per-channel serialization + coalesce +
single-flight render lock + single-flight re-post/create-or-adopt (M2/M3)**,
Discord reminder lane (**single non-`@`-spam reminder — M4**), account-link
(link-code first; OAuth optional). Env (all `requiredInProd`, added to BOTH
`server:` and `runtimeEnv:` in `env.ts`): `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`,
`DISCORD_PUBLIC_KEY`; optional OAuth trio only if doing OAuth link. Service:
**none new** — the interactions route lives in `web`; fan-out runs in `worker`.
CF purge for the new `/uploader/discord/*` + `/uploader/intent` paths.
*Shippable:* Discord signups (few-seconds embed) + edit-in-place embeds.

**Phase 2.5 — SSE upgrade (GATED on infra; optional, replaces poll).**
ONLY after the three prerequisites are made and verified (§4.5 / B2): (1) Caddy
per-path matcher with `flush_interval -1` + `encode` exclusion on the stream
path; (2) **`proxy.ts` matcher regex edited** to exclude the stream path from the
600/60s `globalIp` limiter + CSP processing; (3) heartbeat ≤15s, verified against
the prod CF plan's real idle cutoff (U2). Adds `GET /uploader/stream/team/:id`
(browser) + `GET /uploader/stream/companion`. The browser/companion fall back to
short-poll automatically if the stream drops. *Shippable:* ~1–3s live updates
instead of a few-seconds poll. **If the infra change is rejected, the product is
complete on short-poll — this phase is a latency upgrade, not a dependency.**

**Phase 3 — Addon write-back (DEFAULT: read-only first; B4/M6/M5/M8).**
**Default v1 of the in-game surface is READ-ONLY** (fork 9.A.5 promoted to the
default): the addon shows the schedule + own status + counts from
`StatSmithInbox.lua`; signups happen on web/Discord. This dodges the entire
clobber/CAS/membership-write surface and is the cheap, safe first cut.
Read-only ships: `StatSmithCalendarFrame` (view only), companion inbound writer
(separate `StatSmithInbox.lua`, `Wow.exe`-gated, atomic), `GET
/uploader/calendar/poll` (own status + counts only — M5). Bump addon `##
Version`/`ADDON_VERSION` + the new `StatSmithInbox` `## SavedVariables` line;
re-package MSI.
**Phase 3b — Addon WRITE-back (later, L-sized — the hard part the table priced as
L, M8).** Adds `StatSmithDB.outbox` writer + `authoredAtSignupVersion`; `POST
/uploader/calendar` with the **B4 membership gate + M6 past-event reject + B5
per-signup CAS**; reliable `Wow.exe` detection across launchers (U5). This is the
genuinely hard companion work (process detection, atomic file interlock,
session-boundary reconcile) — schedule it as its own L effort, not a thin add.

**Phase 4 — Optional features** (from the menu, §9): iCal feed, comp templates,
bench/lock, attendance-history analytics, set-on-behalf, pre-warm-sync, etc.,
each independently shippable.

---

## 9. DECISION MENU

### 9.A The genuine forks (need a human decision)

1. **Browser realtime transport.** **Short-polling DAY 1 (now RECOMMENDED
   primary — works through the untouched stack; the only thing the current prod
   infra supports)**; SSE-under-`/uploader/*` as a gated latency upgrade (needs
   Caddy + proxy.ts changes, §4.5/B2). *Recommend ship short-poll first; do SSE
   only if the few-seconds poll proves too slow AND the infra change is
   approved.*
2. **Discord identity link.** Link-code slash command (RECOMMENDED primary —
   **new `DiscordLinkCode` 10-min single-use token, NOT share-token — B3**;
   covers cold-start) vs full Discord OAuth via Auth.js (smoother for logged-in
   users, new public callback). *Recommend link-code first, add OAuth as
   convenience. And: require linking before Discord signups count (attendance
   integrity) vs loose name-matching — recommend strict.*
3. **Recurrence storage.** Materialize concrete rows via a sweeper (RECOMMENDED —
   forced by attendance: each occurrence needs its own id/message/version),
   **keyed on `(seriesId, occurrenceDate)` with re-derive-in-place on tz change
   (M7)**, vs compute-on-read. *Recommend materialize, 8-week rolling window. +
   edit semantics: "this / this-and-future" vs simpler "series or single."*
4. **Discord bot hosting.** HTTP Interactions Endpoint in `web` (RECOMMENDED —
   stateless, deploy-safe, no new container) vs a gateway bot in a new
   always-on service. *Recommend HTTP endpoint.*
5. **In-game write-back depth.** **Read-only in-game FIRST is now the DEFAULT
   (not a fork) (M8)** — show roster/own-status at login; sign up on web/Discord;
   far cheaper, dodges clobber/CAS/membership-write risk. Full bidirectional addon
   write-back is **Phase 3b, later** (B4 membership gate + M6 past-event reject +
   B5 per-signup CAS all required before any write). *The remaining decision is
   only "do we ever fund 3b," not "which first."*
6. **Inbound addon file.** Separate companion-owned `StatSmithInbox.lua`
   (**RECOMMENDED, now baked in** — structural read-only contract; also the
   writer never touches `StatSmithDB`'s existing globals, de-risking the writer —
   M8) vs a `calendar` sub-table inside `StatSmithDB`. *Recommend separate file.*
7. **Reminder default & lead time.** **Single non-`@`-spam reminder linking to
   the embed (default — M4)**, or DM (private, can fail/opt-out); multi-lead
   `Int[]` default `[1440, 240]` (24h + 4h — m5). *Recommend the linked
   non-ping default, per-user opt-out. Explicitly NOT a 15-20-person `@`-ping or
   a second button-bearing message.*
8. **Outbox retention window** (replay vs full-snapshot fallback): 7d vs 30d.
   *Recommend 30d; the first poll/SSE response on a cold/over-retention cursor
   sends current full team state so a beyond-retention client still converges.*
9. **Attendance denominator policy.** What counts as a "scheduled raid" for the %
   (LOCKED only? all PLANNED? exclude cancelled/optional?) and window default
   (4-week vs season) — leader-configurable? *Recommend LOCKED-or-PLANNED minus
   cancelled, 4-week default, leader-configurable.*
10. **(NEW) `LISTEN/NOTIFY` sub-second wake — fund it or not (B1).** The relay
    floor is the 1–2s poll because pgbouncer transaction-mode kills `LISTEN`. A
    sub-second wake needs new infra: a session-mode pgbouncer DB + one pinned
    listener connection in `worker` (+ exposing/reaching Postgres directly, new
    env, new failure domain). *Recommend NO for v1 — 1–2s is fine for a signup
    board; revisit only if a sub-second requirement appears.*

### 9.B Optional-feature menu (S ≤1d · M 2–4d · L 1–2wk; one engineer incl. tests)

CORE (assumed in, not optional): calendar views, event CRUD, the 4 base states,
detail panel + one-tap status, website-as-SoT + outbox sync, **short-poll
transport**.

| # | Feature | Value | Cost | Dependency | Recommend |
|---|---------|-------|------|------------|-----------|
| F1 | Bench/Standby state + leader final-selection/lock | 5th state + Starter/Bench/Cut lock; feeds W5 | M | CORE; `RosterSelection`/`selection` field | Include |
| F2 | Auto-reminders to non-responders (Discord+email+in-game) | Cuts "didn't see it" no-shows | M | CORE; Discord bot (single linked reminder — M4); SMTP (have); scheduler (have) | Include |
| F3 | Recurring weekly schedules | Set the week once; auto-materialize | M | CORE; materializer (M7) | Include (Phase 1) |
| F4 | iCal/Google Calendar export (webcal) | Raids in personal calendar | S | CORE; HMAC token (have); RFC5545 formatter | Include |
| F5 | Attendance-history analytics (signup-only) + no-show/streak | Bench/retention screen | M | CORE | Include — **but observed-presence column gated on the addon observation layer (m4)** |
| F6 | Leader set-status-on-behalf | Handle the raider who texted; audited | S | CORE; audit log (have) | Include |
| F7 | Per-event role/spec caps | "Max 5 healers"; oversubscription guard | M | CORE; spec→role map; readiness meter | Defer |
| F8 | Waitlist / auto-promote | Auto-fill freed capped slot | M | F7; F2 | Defer |
| F9 | Per-viewer TZ + team home TZ | Kills the "what time?" thread | S | CORE render; viewer TZ pref | Include |
| F10 | Absence reasons + per-event comment thread | Context on absences + tactics thread | S–M | CORE detail panel | Include |
| F11 | Locked-roster pre-warms data_refresh sync | Dashboard fresh pre-raid | S | F1 lock; trackedMemberSync queue | Include |
| F12 | Discord bot companion | The Discord signup surface | L | CORE; Discord app + bot token + channel link; **B3 link-code + M1-M4 fixes** | Include (Phase 2) |
| F13 | In-game addon signup GUI | Sign up from the raid GUI (session-bound) | **READ-ONLY = M; WRITE-back = L** | CORE; addon release + companion writer; **write needs B4/M5/M6/B5** | **Read-only FIRST (default); write-back later (Phase 3b)** |
| F14 | Composite reliability index/tier (RAT-style) | Tenure-weighted reliability tiers | M | F5 (must not ship before ledger) | Defer |
| F15 | Comp templates per team | Saved role targets auto-applied | S | CORE; readiness meter | Include |
| F16 | Public read-only event/roster share link | Share signup state publicly | S | CORE; HMAC share-token (have) | Optional |
| F17 | Per-event loot/tactics attachments & links | WCL/MRT-note links on all surfaces | S | CORE notes | Optional |
| F18 | "Signed-but-no-show" auto-flag → officer digest | Weekly reliability-miss digest | S | **F5 + the addon observation layer (m4)** | Optional |

**Recommended default bundle:** all the Smalls already deps-in-repo (F4, F6, F9,
F11, F15) + the Medium backbone (F1 bench/lock, F3 recurrence, F5 history
**signup-only**) that makes the calendar a real management tool. **F12 (Discord)
precedes F13 (addon)** — Discord is few-seconds and higher-leverage; the addon is
session-bound and ships **read-only first**. F18 / the "signed-but-no-show"
headline are **not** in this bundle (they need the observed-presence layer, m4).

---

## 10. Risks, open questions, UNVERIFIED items

### Risks

- **No `LISTEN/NOTIFY` ⇒ relay floor is the 1–2s poll (B1).** Designed-around: the
  feature is a signup board, not a trading floor; 1–2s relay + few-seconds poll is
  fine. Sub-second is fork 9.A.10 (not v1).
- **SSE is NOT a Phase-0 freebie (B2).** It needs a Caddy per-path matcher +
  `proxy.ts` matcher edit + heartbeat, all verified on the prod CF plan. Ship
  short-poll first; SSE is Phase 2.5, gated. *Mitigation:* short-poll is the
  always-available fallback the browser/companion degrade to.
- **Cloudflare `/api` 404 cache** on new paths — every new endpoint MUST be
  `/uploader/*` and a one-time CF purge is required after first deploy.
- **Companion membership gate is load-bearing (B4).** Without an explicit
  `RaidTeamMembership(characterId, event.raidTeamId, isActive)` check on
  `/uploader/calendar`, an off-team character pollutes the roster/ledger. Not
  optional.
- **Link-code is a NEW token (B3), not share-token.** 10-min, single-use,
  user-scoped, individually revocable.
- **Discord rate-limit bans** (10k invalid/10min). *Mitigation:* honor
  `Retry-After` as the only authority; **per-channel serialize** (M2), not just
  per-event coalesce; single-flight re-post + create-or-adopt (M3); single
  non-`@`-spam reminder (M4).
- **Addon clobber if the inbound writer ever runs while WoW is open** — the
  `Wow.exe` process check is load-bearing; the separate `StatSmithInbox.lua` makes
  the read-only contract structural; atomic write + re-stat is belt-and-braces.
- **DST re-derive (M7):** the materializer must re-derive `startsAt` in place
  (keyed on `occurrenceDate`), or a tz-rule change duplicates occurrences.
- **Migration must force-recreate `worker`** or routes 404 (per the
  docker-next-cache-prisma + vps-deploy notes).
- **Spec→role accuracy:** spec lives on `CharacterSnapshot.specName`/addon, not
  `Character`; a stale/missing snapshot mis-groups a name in the role columns.

### Open questions (the decision forks above are the actionable set)

The ten forks in §9.A are the questions to put to the user. Additionally:
- **Multi-character signup default:** auto-pick primary (now required —
  `characterId` is non-null, m3) vs always prompt a character select on first
  signup per event (UX vs integrity)?
- **Absent-reason visibility:** leaders-only vs inline-muted-for-all?
- **Class icons:** invest in custom application emojis (best looks) vs ship
  unicode/role-letter glyphs first?
- **Comp-readiness target source:** hardcoded default vs per-team template (F15)
  vs per-event override (recommend template-with-override; confirm the default
  comp, e.g. 2T/5H/13DPS at 20)?
- **WCL `guildData.guild.attendance` lane:** ignore it (first-party signup +
  addon-observed is sufficient) or surface it as a complementary column?
- **Fund Phase 3b addon write-back at all,** or keep the in-game surface
  read-only indefinitely (fork 9.A.5)?

### UNVERIFIED / to confirm before/while building

- **U1** Discord message-edit limit "~5/channel/~5s" is from community issue
  threads, not the official rate-limit doc (which says buckets are dynamic and
  per-route). *Treat `Retry-After` as the ONLY authoritative limit; the 5/5s
  figure is a design budget, not a contract. Per-channel serialization (M2) is
  the real safety, not the number.*
- **U2** Cloudflare idle cutoff: the connection-limits doc says ~400s, but
  Free/Pro real-world reports cluster at ~100s before a 524. *The ≤15s heartbeat
  covers both; a one-line prod-plan check is a prerequisite of the SSE phase.*
- **U3** Whether the Discord interactions route inside `web` survives a deploy
  bounce gracefully (Discord shows "interaction failed", user re-taps).
  *Acceptable for v1; the micro-service split is the escape hatch.*
- **U4** Custom application-emoji limits + per-guild availability for class icons
  (not verified this session).
- **U5** The companion's reliable `Wow.exe` detection across launchers (Battle.net
  vs standalone, retail process name) — assumed `Wow.exe` on Windows; **this is a
  Phase-3b cost driver, not a footnote** (M8); verify on the target machines.
- **U6** (RESOLVED to a hard constraint — see B1) Postgres `LISTEN/NOTIFY`
  through pgbouncer transaction mode: **confirmed unsupported** (pgbouncer drops
  the session-pinned backend). The 1–2s polling relay is THE floor, not a
  fallback. Sub-second requires the fork-9.A.10 infra.
- **U7** Exact addon SavedVariables flush behavior at character-select vs
  full-client-exit for *inbound* writes — detail-file C asserts only a full
  client exit is reliably safe; the `Wow.exe`-absent guard enforces this
  conservatively regardless.

### Sources (carried from the detail files; cited inline there)

Discord interactions/rate-limits/oauth2 (`docs.discord.com/developers/*`,
discord-api-docs issues #1454/#5810); WoW SavedVariables timing
(`warcraft.wiki.gg` AddOn loading process / Saving variables / SavedVariables);
transactional outbox + delivery guarantees (microservices.io, AWS prescriptive
guidance, event-driven.io); pgbouncer LISTEN/NOTIFY in transaction mode
(pgbouncer features doc + issue #655); Cloudflare SSE/idle + keep-alive
(developers.cloudflare.com connection-limits, CF community 100s thread); SSE vs
WebSocket + Last-Event-ID (MDN, Wikipedia); RRULE/DST/IANA materialization
(nylas.com, rrule.net, iCalendar RFC 5545, appmaster.io). Repo facts verified
against `prisma/schema.prisma`, `src/server/ingestion/queues.ts`,
`addon/StatSmith/StatSmith.lua`, `companion/upload.mjs`,
`src/app/uploader/ingest/route.ts`, `src/server/api/trpc.ts`,
`src/server/security/share-token.ts`, `src/server/security/rate-limit.ts`,
`src/proxy.ts`, `src/lib/db.ts`, `docker-compose.prod.yml`, `Caddyfile`.

---

## 11. Critic resolution log

Disposition of every issue in `f-critique.md` (agent F). Each was re-verified
against the live tree before acting.

### BLOCKERS — all fixed

- **B1 (no `LISTEN/NOTIFY` through pgbouncer txn mode).** ACCEPTED, verified
  (compose L60/L92/L126 `POOL_MODE: transaction`; no `DIRECT_URL`; db.ts single
  `PrismaPg`; postgres unexposed). Removed every NOTIFY/"sub-100ms" claim. Relay
  floor is now stated as the **1–2s poll** everywhere (§1.3, §2 diagram, §4.2,
  §4.3 table). The session-mode-listener option is demoted to **fork 9.A.10
  (not v1)**. U6 reclassified from "to confirm" to "confirmed unsupported."

- **B2 (SSE broken through current Caddy + proxy.ts; assumed config doesn't
  exist).** ACCEPTED, verified (Caddyfile L5 global `encode`, L27-31 single proxy
  no matcher; proxy.ts L93 matcher includes all non-health paths +
  `consumeLimit(globalIp)` L40; rate-limit.ts L128 = 600/60s). **Day-one
  transport switched to SHORT-POLL** (`GET /uploader/poll/team/:id?since=`),
  which works through the untouched stack. SSE is now **Phase 2.5, gated** on
  three explicit prerequisites incl. an **explicit `proxy.ts` matcher-regex
  edit** (called out as a code change, not a footnote) and a Caddy per-path
  matcher. Phase 0 no longer ships SSE.

- **B3 (link-code "reuses share-token" but that token is 7-30d, has no user
  field, can't be individually revoked).** ACCEPTED, verified (share-token.ts
  L33-34 TTL 7/30, L36-40 payload d/r/e no u, L16-18 revocation = rotate
  AUTH_SECRET). Introduced a **new `DiscordLinkCode` model (§3.6):** 10-min TTL,
  single-use burn (`consumedAt`), user-scoped, individually revocable. §5.3 and
  fork 9.A.2 rewritten to use it; share-token explicitly rejected for this
  purpose.

- **B4 (companion calendar leg lets a user sign up an off-team character; gate
  is character-ownership only).** ACCEPTED, verified (ingest/route.ts L122-136 =
  `character.findMany({where:{userId}})` only; `RaidTeamMembership`
  `@@unique([raidTeamId, characterId])` + `isActive` schema L391-409). Added an
  **explicit server-side `RaidTeamMembership(characterId, event.raidTeamId,
  isActive)` check** as a hard requirement on `/uploader/calendar` (§1.3, §3.7,
  §4.1, §6.1, §6.5, risks). Made it a prerequisite of Phase 3b.

- **B5 (CAS compares the addon's per-EVENT version against a per-SIGNUP version —
  unsound).** ACCEPTED, verified (§3.2 `RaidEvent.version` bumps on any change;
  §3.3 `EventSignup.version` per signup). The CAS now uses **`EventSignup.version`
  exclusively**; the inbound file ships **`mySignupVersion` per event** and the
  outbox carries **`authoredAtSignupVersion`** (§4.1, §6.2). `RaidEvent.version`
  is explicitly excluded from the CAS (carried only for display freshness),
  killing the over-rejection of a player's own valid pick.

### MAJOR — all fixed

- **M1 (DEFERRED_UPDATE_MESSAGE + worker bot-token PATCH leaves a hanging
  spinner / two edit mechanisms conflated).** ACCEPTED. Picked the clean path:
  **ephemeral ack (type 4, flags=64) + async bot-token PATCH**; removed all
  `DEFERRED_UPDATE_MESSAGE` (type 6) language (§4.3 leg 3, §5.2). Decouples the
  public embed edit from the 15-min interaction token entirely.

- **M2 (per-team-channel coalescing doesn't save you across multiple events in
  one channel; "comfortably inside 5/5s" is wrong).** ACCEPTED. Added
  **per-CHANNEL serialization across events** (a single per-channel token-bucket/
  serial lane gating all renders + reminders for that channel) as the load-bearing
  mechanism (§5.4.4). Restated `Retry-After` as the only contract; the 5/5s figure
  is a budget (§5.4, U1).

- **M3 (404 self-heal can double-post under concurrency).** ACCEPTED. Added a
  **dedicated `discord:repost:lock:<eventId>` single-flight** + **create-or-adopt
  keyed on `(channelId, eventId)`** (search channel for an existing eventId-marked
  bot embed before posting) + a `discordRepostLock` field on `RaidEvent` (§5.5,
  §3.3).

- **M4 (reminder "@-ping 15-20 non-responders with buttons attached" = spam +
  second desync-prone interactive message).** ACCEPTED. Reminder is now a
  **single non-`@`-spam message linking to the embed** (or DM-with-fallback), with
  **no second button-bearing message** (§5.2.9, fork 9.A.7, F2 row). Removed the
  mass-ping + reminder-buttons design.

- **M5 (companion SSE/token leaked-token blast radius).** ACCEPTED. Hard rule:
  the companion poll/SSE streams **only the token-user's own status + aggregate
  counts**, never other raiders' identities/states (§4.5, §6.1, §6.2, §6.5).
  `/uploader/calendar` enforces the B4 membership + per-(member,event) ownership.
  Added **upload-token rotation UX** to the requirements and a per-token/per-IP
  cap on concurrent streams.

- **M6 (past-event / late-flush race resurrects signups).** ACCEPTED. Added a
  server rule: **reject signup intents for events past `startsAt + durationMin`**
  on both `/uploader/calendar` and `/uploader/intent`, with an ack so the
  companion prunes its outbox (§4.1, §4.3 leg 5, §6.1). Defines the outbound
  staleness cap.

- **M7 (daily materialize + `ON CONFLICT DO NOTHING` on `startsAt` can't correct
  a DST/tz-rule change — it duplicates the occurrence).** ACCEPTED. Changed the
  materialization unique key to **`(seriesId, occurrenceDate)`** (the stable local
  date) and made the job **re-derive `startsAt` in place and UPDATE on change**
  (§3.3, §4.4). Added the `occurrenceDate` field. Signups + Discord message stay
  attached to the same row.

- **M8 (Phase 0 over-scoped with SSE; addon phase under-scoped on companion
  clobber-detection).** ACCEPTED. (a) Phase 0 ships **short-poll**, SSE is its own
  gated **Phase 2.5** (§8). (b) Split the addon into **read-only Phase 3 (default)
  + write-back Phase 3b (later, L)**; the `Wow.exe` detection / atomic interlock
  is named as the L-sized cost, and the separate `StatSmithInbox.lua` removes the
  merge-into-existing-globals hazard. Read-only-first is now the **default**, not
  a fork.

### MINOR — addressed

- **m1 ("near-real-time (seconds)" oversells).** FIXED — wording changed to "a
  few seconds" for visible convergence; "sub-second" reserved for the interaction
  ack only (§1.2, §4.3, m1-aware throughout).
- **m2 (`DeliveryCursor` per browser session leaks rows).** FIXED — browsers
  carry their cursor **client-side** (`?since=`/`Last-Event-ID`); persisted
  cursors only for `discord` + `companion:<userId>` (§3.4).
- **m3 (`characterId` nullable breaks the unique key / dedup).** FIXED —
  `characterId` is now **REQUIRED** (default primary char); the `(raidEventId,
  characterId)` unique key has no NULL hole (§3.3).
- **m4 (F5 "signed CONFIRM but observed absent" needs the deferred observation
  layer).** FIXED — F5 ships **signup-only**; the observed-presence column +
  no-show headline are **explicitly gated** on the addon observation layer; not
  marketed as in the recommended bundle (§7.4, F5/F18 rows).
- **m5 (single `reminderLeadMinutes` under-delivers "T-minus N hours").** FIXED —
  `reminderLeadsMinutes Int[]` default `[1440, 240]` (§3.5, fork 9.A.7).
- **m6 (Ed25519 raw-body footgun).** FIXED — §5.1 now explicitly mandates `await
  req.text()` (raw) and warns against `await req.json()` first.
