# Overview

## What this is

A secure, self-hosted web app that lets World of Warcraft guild officers
build customised stat-tracking dashboards for their raid teams. Pulls
character, M+, raid, vault, and parse data from the public APIs (Blizzard,
Warcraft Logs, Raider.IO) and — optionally — WoW Audit, then renders
configurable widgets scoped to guild-internal raid teams.

The app replaces the manual Google Sheet workflow demonstrated by the
"Eclipse Midnight" reference spreadsheet (iLvL audit, tier-set tracker, M+
ratings, vault progress, missing enchants/gems, weekly attendance).

## Who uses it

Three roles, in increasing privilege:

- **Member** — a guild member with a Battle.net-linked character in the
  guild's roster. Can view raid-team dashboards they're a member of.
- **Officer** — manages the guild (approve / promote members, manage WoW
  Audit settings, kick off manual roster refreshes, create raid teams).
- **Owner** — first GM-rank member to claim the guild. Full guild control.
  Can transfer ownership.

Layered on top:

- **Raid leader** — designated per raid team. Manages that team's roster
  and dashboards. Can be different from the guild owner.
- **Platform admin** — listed in `ADMIN_USER_IDS` env var. Sees `/admin/*`
  pages, can manually claim guilds when no GM has registered (14-day
  fallback documented in the plan).

## Hosting model

Single-tenant, self-hosted via Docker on a VPS (Hetzner / Fly.io target).
Not a SaaS — every deploy serves one community or organisation. Multiple
guilds within a deployment is fine (the data model supports it), but
cross-deployment data sharing is out of scope.

## Why these tools

The original plan deliberately picked a server-rendered stack with strong
type safety (Next.js + tRPC + Prisma + TypeScript strict) over a SPA + REST
split, because the audit workflow has zero offline / mobile-app
requirements and the dataset (≤25 characters per raid team) is small
enough that server-side composition wins on latency and accessibility.

Auth.js was chosen over a hand-rolled session system because Battle.net
OAuth is a hard requirement and Auth.js's Battle.net provider is mature.
Credentials sign-in (email + password) is the primary auth — Battle.net
links to an existing account rather than acting as a sole identity.

BullMQ on Redis is the ingestion scheduler because the sync model is
explicitly tiered (hourly tracked / weekly guild / on-demand) and BullMQ's
repeatable jobs + per-job backoff + dead-letter queue cover that natively.
