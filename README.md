# raid-team-stats

Customizable raid-team stat tracking for World of Warcraft guilds. Pulls character,
M+, raid, vault, and parse data from Blizzard, Warcraft Logs, and Raider.IO and
renders configurable dashboards scoped to guild-internal raid teams.

> Phase 1 of a multi-phase build. The current commit ships only the secure
> foundation — auth, guilds, and dashboards land in subsequent phases. See
> `~/.claude/plans/synchronous-inventing-candle.md` for the full plan.

## Stack

| Layer | Choice |
|-------|--------|
| App framework | Next.js 16 (App Router) + React 19 + TypeScript strict |
| API layer | tRPC v11 (added wiring in Phase 2) |
| Auth | Auth.js v5 with Battle.net OIDC + Credentials (Argon2id) |
| Database | PostgreSQL 16 via Prisma 7 (`@prisma/adapter-pg` driver adapter) |
| Cache / queue | Redis 7 + BullMQ (workers in Phase 4) |
| Styling | Tailwind 4 (CSS-first), shadcn/ui (added in Phase 2) |
| Reverse proxy | Caddy (auto-TLS in production) |
| Logging | pino with secret redaction |

## Local development

### Prerequisites

- Node.js **22+** (see `Dockerfile` for the production target).
- Docker / Docker Desktop for Postgres + Redis.

### Boot

```bash
# 1. Install deps (postinstall runs `prisma generate`).
npm install

# 2. Copy and tweak the env. The placeholder secrets in .env let the app start
#    in development; production env vars are validated strictly.
cp .env.example .env

# 3. Start Postgres + Redis.
docker compose up -d

# 4. Apply the schema (creates tables in the local DB).
npm run db:migrate -- --name init

# 5. Run the dev server.
npm run dev
```

App boots on <http://localhost:3000>. Health probes at `/api/health` and
`/api/ready`.

> **OneDrive note:** This repo lives under a OneDrive-synced folder on Windows.
> If you see file-lock or sync-conflict errors, pause OneDrive sync for the
> repo folder during development (right-click the folder → Free Up Space /
> Pause syncing).

### Common scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | Next dev server with Turbopack HMR |
| `npm run build` | Production build |
| `npm run start` | Run the production server |
| `npm run lint` | ESLint (flat config) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest one-shot |
| `npm run test:watch` | Vitest watch mode |
| `npm run db:migrate` | Run Prisma migrations against the dev DB |
| `npm run db:generate` | Regenerate the Prisma client into `src/generated/prisma/` |
| `npm run db:studio` | Prisma Studio (visual DB browser) |

## Security baseline (Phase 1)

What's already enforced before any feature code lands:

- **CSP** with per-request cryptographic nonce; no `unsafe-inline`. Built in
  `src/server/security/csp.ts`, applied in `src/proxy.ts`.
- **HSTS** (`max-age=2y`, `includeSubDomains`, `preload`) on HTTPS responses.
- **`X-Frame-Options: DENY`** + CSP `frame-ancestors 'none'`.
- **`Referrer-Policy: strict-origin-when-cross-origin`**, restrictive
  Permissions-Policy, `Cross-Origin-*` isolation headers.
- **Sliding-window rate limit** (Redis + Lua) on every non-static request.
- **Audit log** schema and append-only writer ready for use.
- **Secrets redacted** from logs via pino's redact paths.
- **Strict env validation** via `@t3-oss/env-nextjs` — boot fails fast in
  production if any required var is missing.
- **Strict TypeScript** + ESLint configured.

See [`SECURITY.md`](./SECURITY.md) for the disclosure policy, accepted
dependency advisories, and cryptographic choices.

## Layout

```
src/
├── app/                # Next.js App Router pages and API routes
│   ├── api/health/     # liveness probe
│   ├── api/ready/      # readiness probe (DB + Redis)
│   ├── layout.tsx      # root layout, reads CSP nonce from request header
│   └── page.tsx        # placeholder landing page
├── env.ts              # zod-validated env vars
├── lib/
│   ├── db.ts           # Prisma client singleton (pg driver adapter)
│   ├── logger.ts       # pino with secret redaction
│   └── redis.ts        # ioredis singletons (app + BullMQ blocking)
├── server/
│   └── security/
│       ├── audit.ts        # audit log writer
│       ├── csp.ts          # CSP policy + nonce
│       ├── headers.ts      # security header set
│       └── rate-limit.ts   # Redis sliding-window
└── proxy.ts            # Next 16 proxy.ts — applies CSP/headers + rate limit
```

## Production deployment (sketch)

Phase 6 ships the full production compose. For now, the building blocks are:

- `Dockerfile` — multi-stage build, non-root runtime user, healthcheck.
- `Caddyfile` — TLS termination, security headers, reverse proxy to `web:3000`.
- `.github/workflows/ci.yml` — lint, typecheck, test, build, npm audit.

## Roadmap

| Phase | Deliverable |
|-------|-------------|
| 1 ✅ | Foundation: scaffolding, CSP, rate-limit, audit, health probes |
| 2 | Auth.js + email verification + Battle.net link + profile page |
| 3 | Guild verification + RaidTeam model + departure cascade |
| 4 | Three-tier sync (hourly tracked / weekly guild / on-demand) |
| 5 | Customizable dashboards with widget palette |
| 6 | Production compose, backups, observability, security tests |

## License

TBD.
