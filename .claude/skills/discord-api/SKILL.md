---
name: discord-api
description: Use this skill whenever this project talks to Discord — verifying interaction webhooks, responding to interactions (buttons/modals/slash commands), posting/editing channel messages with the bot token, registering slash commands, or linking a Discord account. Single source of truth for the HTTP-Interactions model, Ed25519 verification, REST endpoints, response types, rate limits, and the load-bearing gotchas. If the live API or code contradicts this file, fix it in the same session.
---

# Discord API (HTTP Interactions, no gateway)

We use the **HTTP Interactions Endpoint + outbound REST (bot token)** model —
**no gateway WebSocket, no discord.js**. Discord POSTs interactions to our
endpoint; we send/edit messages over REST. Stateless: a redeploy drops zero
events. Code: [src/lib/discord/](../../../src/lib/discord/),
[src/app/uploader/discord/interactions/route.ts](../../../src/app/uploader/discord/interactions/route.ts),
fan-out in [src/server/calendar/discord/](../../../src/server/calendar/discord/).
Full design: [docs/design/raid-calendar-attendance.md](../../../docs/design/raid-calendar-attendance.md) §5.

## Env (OPTIONAL — all-or-nothing; in BOTH `server:` and `runtimeEnv:` of env.ts)
All three are `z.string().min(1).optional()` (NOT `requiredInProd`): the bot turns
on only when ALL THREE are set; absent any one it's disabled and the rest of the
app runs normally (a deploy never breaks for not using Discord). Gate via `discordConfig()`.
- `DISCORD_APP_ID` — application (client) id (snowflake).
- `DISCORD_PUBLIC_KEY` — Ed25519 public key (hex) for verifying interactions.
- `DISCORD_BOT_TOKEN` — bot token for outbound REST (`Authorization: Bot <token>`).

## Interactions endpoint (`POST /uploader/discord/interactions`)
- Under `/uploader/*` so a new path doesn't hit Cloudflare's edge-cached `/api`
  404 (purge CF once after deploy — see [vps-deploy](../vps-deploy/SKILL.md)).
- **Verify Ed25519 over the RAW body (load-bearing for AUTH, not just registration).**
  Signature = `X-Signature-Ed25519` (hex), timestamp = `X-Signature-Timestamp`.
  Verify `timestamp || rawBody` against `DISCORD_PUBLIC_KEY` via Node
  `crypto.verify("ed25519", msg, keyObject, sigBuf)`. **MUST `await req.text()`
  (raw) — NEVER `req.json()`**; re-serialization changes bytes → sig fails.
  Bad/absent signature → **401** (Discord sends routine invalid-signature probes;
  401 is expected, not an outage).
- Interaction **types**: `1 PING` → respond `{type:1}` PONG. `2 APPLICATION_COMMAND`
  (slash). `3 MESSAGE_COMPONENT` (button/select). `4 APPLICATION_COMMAND_AUTOCOMPLETE`.
  `5 MODAL_SUBMIT`.
- We trust the **signed** `interaction.member.user.id` (or `interaction.user.id`
  in DMs) as the Discord snowflake. Map snowflake → site user via
  `Account(provider="discord", providerAccountId=<snowflake>)`. **NEVER trust
  Discord guild roles for authz** — re-check `RaidTeamMembership.role`.

## Interaction RESPONSE types (the <3s reply)
- `1 PONG` (ping only).
- `4 CHANNEL_MESSAGE_WITH_SOURCE` — `{type:4, data:{content, flags}}`. **flags:64
  = EPHEMERAL** (only the tapper sees it).
- `5 DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` — "thinking…", edit later via the
  interaction token (`PATCH /webhooks/{app_id}/{token}/messages/@original`).
- `6 DEFERRED_UPDATE_MESSAGE` — **DO NOT USE for our signup buttons (M1).** It
  promises the component message is edited via the *interaction* token, but we
  edit the embed later via a *separate bot-token PATCH from the worker*. If the
  worker is backed up, the 15-min token lapses → user sees "This interaction
  failed." Use **type 4 ephemeral ack** instead; the public embed edit is async.
- `7 UPDATE_MESSAGE` — edit the component message inline (we don't, single-writer).
- `9 MODAL` — `{type:9, data:{custom_id, title, components}}`. Opening a modal IS
  a valid <3s response (used for Late-ETA and Absent-reason).
- `8 AUTOCOMPLETE_RESULT` — `{type:8, data:{choices:[{name,value}]}}`.

**Pattern for a signup tap:** verify → respond **type-4 ephemeral ack** (or
type-9 modal) in <3s → apply the intent to the DB (the shared signup-intent
service) → the embed is re-rendered LATER by the worker fan-out via bot-token
PATCH. Discord stores nothing authoritative; the website DB is the source of truth.

## Outbound REST (bot token)
Base `https://discord.com/api/v10`. Header `Authorization: Bot <DISCORD_BOT_TOKEN>`.
- Post embed: `POST /channels/{channelId}/messages` body `{embeds:[…], components:[…]}`.
- **Edit in place: `PATCH /channels/{channelId}/messages/{messageId}`** — same body.
  404 = message deleted → re-post (single-flighted, create-or-adopt — see §5.5).
- Register guild slash commands: `PUT /applications/{appId}/guilds/{guildId}/commands`
  body = array of command objects (bulk overwrite).
- Follow-up/edit ack: `PATCH /webhooks/{appId}/{interactionToken}/messages/@original`.

## Components & embeds (quick shapes)
- Action row: `{type:1, components:[…]}` (max 5 buttons/row, 5 rows).
- Button: `{type:2, style, label, custom_id, emoji?}`. style 1 primary(blurple)
  2 secondary(grey) 3 success(green) 4 danger(red) 5 link(`url`, no custom_id).
- **custom_id carries our routing** (≤100 chars), e.g. `att|<eventId>|CONFIRM`.
- Modal text input: `{type:1,components:[{type:4, custom_id, label, style:1|2,
  required, max_length}]}`. style 1 short, 2 paragraph.
- Embed: `{title, description, color(int), fields:[{name,value,inline}], footer:{text},
  timestamp}`. We stamp the eventId in the footer for create-or-adopt recovery.

## Rate limits & coalescing (worker, not request path)
- Global **50 req/s** per bot; **interaction responses are exempt**. Per-resource
  buckets keyed by `channel_id`/`guild_id`. **Always honor `Retry-After`** (the
  only authoritative limit). 10k invalid(401/403/429)/10min → temp CF IP ban.
- The community "~5 edits/channel/5s" is a **design budget, not a contract**.
- Strategy: **per-channel serialized + coalesced + single-flight** (reuse
  `rate-limit/token-bucket.ts` keyed by `channel_id`). N taps in a 2s burst → 1
  edit. Re-post has its OWN lock (`discord:repost:lock:<eventId>`) distinct from
  the render lock, or two relays both observe a 404 and post two embeds (M3).
- **429** → read `Retry-After`, sleep, RE-READ DB at retry (never PATCH stale state).

## Account linking (link-code, primary)
- `DiscordLinkCode` (10-min TTL, single-use `consumedAt` burn) — NOT share-token.
  Website shows a code; `/statsmith link code:<CODE>` validates (unexpired +
  unconsumed), atomically burns it, writes `Account(provider="discord",
  providerAccountId=<snowflake>)`. Reuses `@@unique([provider, providerAccountId])`.
- OAuth2 (`identify`) via Auth.js is the optional convenience path (new public
  callback → CF-404-prone until purged).

## Install (per Discord guild, by an admin)
`oauth2/authorize?client_id=…&scope=bot+applications.commands&permissions=<INT>`.
Permissions: View Channel + Send Messages + Embed Links + Read Message History +
Create Public Threads + Send Messages in Threads. **NEVER Administrator (`8`).**
Intents: **none** (HTTP interactions need no gateway intents; no Message Content).
