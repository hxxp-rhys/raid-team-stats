# raid-team-stats

Customizable raid-team stat tracking for World of Warcraft guilds. Pulls character,
M+, raid, vault, and parse data from Blizzard, Warcraft Logs, and Raider.IO and
renders configurable dashboards scoped to guild-internal raid teams.

> 💙 **Free & open source.** If your guild finds this useful, you can support
> development and hosting via the **[Sponsor button](https://github.com/sponsors/hxxp-rhys)**.
> Totally optional — the app and the in-game addon are free and always will be.

## Setup / self-hosting

**New here? Start with [SETUP.md](./SETUP.md)** — a step-by-step guide to running
your own instance (Docker, API credentials, and the optional in-game addon) so
any guild can stand it up with minimal effort.

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

- Docker / Docker Desktop (the full stack runs in containers).
- Node.js **22+** on the host is **optional** — only needed if you fall back
  to running `next dev` natively for faster HMR on Windows.

### Boot (containerized — primary path)

```bash
# 1. Copy and tweak the env. The placeholder secrets let the app start in
#    development; production env vars are validated strictly.
cp .env.example .env

# 2. Bring up Postgres, Redis, and the Next.js dev server.
#    First run builds the dev image (~2 min); subsequent runs are seconds.
docker compose up
```

App boots on <http://localhost:3000>. Health probes at `/api/health` and
`/api/ready`. The container starts by running `prisma generate` and
`prisma migrate deploy` automatically, so the schema is always in sync with
the committed migrations.

Schema changes while running:

```bash
docker compose exec web npx prisma migrate dev --name <descriptive_name>
```

Dependency changes (a new `npm install` ran on the host)? The container's
`node_modules` lives in a named volume that doesn't see host changes — refresh
it once:

```bash
docker compose exec web npm install --no-audit --no-fund
docker compose restart web
```

Smoke-testing the verify/reset flow without an email round-trip:

```bash
docker compose exec web npx tsx scripts/dev-issue-verify-token.ts verify_email user@example.com
```

### Boot (native host — optional, faster HMR on Windows)

If file-watching feels sluggish in Docker on Windows/WSL2:

```bash
npm install
docker compose up -d postgres redis
npm run db:migrate -- --name init
npm run dev
```

> **OneDrive note:** This repo lives under a OneDrive-synced folder on Windows.
> If you see file-lock or sync-conflict errors during native-host dev, pause
> OneDrive sync for the repo folder (right-click → Free Up Space / Pause
> syncing).

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

## Hardening your hosting environment

The app already encrypts the most sensitive data itself (passwords with Argon2id;
OAuth and MFA secrets with AES‑256‑GCM) and ships with strict security headers,
rate limiting, authenticated Redis, and hardened containers. But a few important
protections live in the **hosting environment**, not the code — and they matter
most when you're handling real people's data (logins, emails, and recruitment
applications). Here's what to do and *why*, with quick examples for **AWS**,
**Azure**, and a **self‑hosted** VPS.

> **Rule of thumb:** only **80/443** should ever be reachable from the internet.
> The database, cache, pooler, metrics, and dashboards all stay on a private network.

### 1. Encrypt the disks at rest
**Why:** your database, Redis (which persists API tokens and job data to disk), the
backups, and any recruitment applications all live on disk. Disk encryption makes a
stolen disk, snapshot, or decommissioned drive useless to an attacker — it's the
safety net underneath everything the app doesn't field‑encrypt itself.
- **AWS:** turn on EBS encryption (enable account‑level *"Always encrypt new EBS volumes"*); use an encrypted RDS instance and encrypted snapshots.
- **Azure:** managed disks are encrypted by default; add Azure Disk Encryption or a customer‑managed key in Key Vault for stronger control.
- **Self‑hosted:** enable full‑disk encryption (LUKS) on the data partition. Check with `lsblk -o NAME,FSTYPE,MOUNTPOINT` and `cryptsetup status`.

### 2. Lock down the firewall / network
**Why:** Postgres, Redis, and PgBouncer trust their private network and aren't meant
to face the internet. If a data port is exposed, an attacker can reach it directly.
- **AWS:** a Security Group on the web tier that allows only 80/443 from `0.0.0.0/0`; put RDS / ElastiCache in a private subnet whose SG only accepts the app's SG.
- **Azure:** a Network Security Group allowing 80/443 inbound and denying the rest; keep the database on a private endpoint / VNet.
- **Self‑hosted:** `ufw default deny incoming; ufw allow 80; ufw allow 443; ufw allow <your-ssh-port>`. Never `docker run -p` a data port (the compose files already bind dev ports to `127.0.0.1`). If you front the app with Cloudflare, also restrict the origin to Cloudflare's IP ranges so nobody can bypass it.

### 3. Force HTTPS everywhere, strictly
**Why:** TLS protects every login, token, and personal detail in transit and blocks
downgrade attacks.
- **AWS:** terminate TLS at an ALB with an auto‑renewing ACM certificate; redirect 80→443.
- **Azure:** Application Gateway or Front Door with a managed certificate; enable *"HTTPS only."*
- **Self‑hosted:** Caddy already auto‑provisions Let's Encrypt certificates and sends HSTS. If Cloudflare is in front, set SSL/TLS mode to **Full (strict)** (so Cloudflare→origin is verified too) and enable *"Always Use HTTPS."*

### 4. Encrypt the database connection (or keep it on a trusted network)
**Why:** by default the app talks to Postgres over the private Docker network in
plaintext — fine on a single host, but a risk the moment the database lives on a
separate machine.
- **AWS:** use RDS for PostgreSQL with `rds.force_ssl=1`, and put `?sslmode=verify-full` (plus the RDS CA bundle) in `DATABASE_URL`.
- **Azure:** Azure Database for PostgreSQL enforces TLS by default; use `sslmode=verify-full`.
- **Self‑hosted:** keeping Postgres and the app on the same host's private bridge is an acceptable trusted boundary. If they're on different hosts, enable Postgres server TLS and use `sslmode=verify-full`.

### 5. Keep secrets in a managed store, not a plaintext file
**Why:** `.env.prod` sits in cleartext on the host. A secret store adds access
control, rotation, and an audit trail, and keeps secrets out of disk images and backups.
- **AWS:** store secrets in Secrets Manager or SSM Parameter Store (SecureString) and inject them at container start; give the instance an IAM role instead of static keys.
- **Azure:** store them in Key Vault and read them via a managed identity (nothing on disk).
- **Self‑hosted:** use Docker secrets or a SOPS‑encrypted env file. At minimum, `chmod 600` the `.env.prod`, own it as `root`, and exclude it from backups.

### 6. Encrypt, off‑site, and test your backups
**Why:** a backup is a full copy of everyone's data — it must be encrypted, stored
off the host, and actually restorable.
- **AWS:** RDS automated snapshots are encrypted; or send the bundled backup to an S3 bucket with SSE, versioning, and lifecycle rules.
- **Azure:** Azure Backup, or send the bundled backup to Blob Storage (encrypted at rest).
- **Self‑hosted:** the repo ships an **age‑encrypted** `pg_dump` → `rclone` backup (`scripts/backup.sh`, the `backup` compose profile). Set `BACKUP_AGE_PUBKEY` + `RCLONE_REMOTE`, keep the age **private** key offline, and **test a restore** now and then.

### 7. Rotate credentials and use least privilege
**Why:** rotation limits how long a leaked secret stays useful; least privilege limits
how much one leaked credential can touch.
- Rotate `AUTH_SECRET`, `SHARE_TOKEN_SECRET` (kept separate so you can revoke *all* share links without logging everyone out), `TOKEN_ENCRYPTION_KEY`, the Postgres/Redis passwords, and provider API keys on a schedule.
- **AWS / Azure:** use Secrets Manager / Key Vault rotation, and scope IAM or managed‑identity roles to exactly what's needed.
- **Self‑hosted:** the app already connects as a non‑superuser Postgres role — keep it that way. Regenerate the in‑game **upload token** from the Account page if a machine is lost (it's a long‑lived bearer credential).

### 8. Patch and scan
**Why:** most real compromises use known, already‑patched vulnerabilities.
- **AWS / Azure:** enable image scanning (ECR / ACR) and managed OS patching.
- **Self‑hosted:** enable `unattended-upgrades`, keep Docker updated, and watch the repo's CI scans (Trivy + `npm audit` run on every change). Also lock down SSH: key‑only auth, no root login.

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
