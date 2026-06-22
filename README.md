# Raid Team Stats

Customizable raid-team stat tracking for World of Warcraft guilds. It pulls
character, Mythic+, raid, vault, and parse data from **Blizzard**, **Warcraft
Logs**, and **Raider.IO** and renders configurable dashboards scoped to
guild-internal raid teams — with an optional in-game addon for data the API
doesn't expose.

> 💙 **Free & open source.** If your guild finds this useful, you can support
> development and hosting via the **[Sponsor button](https://github.com/sponsors/hxxp-rhys)**.
> Totally optional — the app and the in-game addon are free and always will be.

---

## Features

- **Character & roster tracking** — gear, Mythic+ score, raid progression, and
  great-vault state, synced on a three-tier schedule (hourly tracked / weekly
  guild / on-demand).
- **Parse analytics** — Warcraft Logs rankings and coaching widgets
  (death ledgers, attendance, learning curves).
- **Customizable dashboards** — a widget palette teams arrange themselves.
- **Accounts & guild verification** — Battle.net login, email/password with
  Argon2id, MFA, and guild-ownership checks.
- **Raid calendar** with optional **Discord** integration.
- **In-game addon + companion** for data the Blizzard API doesn't expose.
- **Admin console** — settings, audit/security log, retention policy, and a
  built-in monitoring stack.

---

## Tech stack

| Layer | Choice |
|-------|--------|
| App framework | Next.js 16 (App Router) + React 19 + TypeScript (strict) |
| API layer | tRPC v11 |
| Auth | Auth.js v5 — Battle.net OIDC + Credentials (Argon2id) |
| Database | PostgreSQL 16 via Prisma 7 (`@prisma/adapter-pg`) + PgBouncer |
| Cache / queue | Redis 7 + BullMQ workers |
| Styling | Tailwind 4 (CSS-first) + shadcn/ui |
| Reverse proxy | Caddy (TLS: Let's Encrypt, your own cert, or self-signed) |
| Observability | Prometheus + Loki + Promtail + Grafana |
| Logging | pino with secret redaction |

---

## Getting started

There are two paths — pick the one that matches what you want to do:

### 🚀 Deploy it (self-host for your guild)

Everything you need is in the **[`Setup/`](./Setup/) folder** — a self-contained
production package that runs a pre-built image. You edit **one file** and run
**one command**:

```bash
cd Setup
cp .env.example .env && ./generate-secrets.sh    # configure
./init-storage.sh                                # prepare storage
docker compose up -d                             # launch (auto-TLS, auto-migrate)
```

**→ Follow the step-by-step guide in [`Setup/README.md`](./Setup/README.md).**
It covers DNS, registering your Battle.net / Warcraft Logs / email credentials,
the (default-on, opt-out) monitoring stack, backups, and updates.

### 🛠️ Develop it (run locally)

For a local development environment (hot reload, the test suite, schema
changes), see **[SETUP.md](./SETUP.md)** and the [Local development](#local-development)
section below.

---

## Local development

**Prerequisites:** Docker / Docker Desktop, and Node.js 22+ on the host for the
Next.js dev server + the test suite.

To run a **full instance** locally, use the single [`Setup/`](./Setup/) Compose
stack — the same package as production. It pulls the pre-built image and runs in
production mode, so it needs your Battle.net / Warcraft Logs / SMTP credentials;
for a no-DNS local run set `APP_HOST=localhost`, `APP_URL` / `AUTH_URL=https://localhost`,
and `TLS_MODE=internal`. Full walkthrough: **[SETUP.md](./SETUP.md)**.

For **code changes with hot reload**, run `npm run dev` (Next.js dev server,
development mode — provider keys optional). It needs a reachable Postgres + Redis
and a populated root `.env` (copy `.env.example`, then set at least `AUTH_SECRET`
and `TOKEN_ENCRYPTION_KEY`); apply the schema with `npm run db:migrate`.

Health checks live at `/api/health` and `/api/ready`.

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

---

## Security

Enforced in the app itself, before any feature code:

- **CSP** with a per-request cryptographic nonce (no `unsafe-inline`).
- **HSTS** (2-year, `includeSubDomains`, `preload`), `X-Frame-Options: DENY` +
  CSP `frame-ancestors 'none'`, restrictive Permissions-Policy and
  Cross-Origin isolation headers.
- **Sliding-window rate limiting** (Redis + Lua) on every non-static request.
- **Encryption at rest** — Argon2id password hashes; AES-256-GCM for OAuth
  tokens, MFA secrets, and PII.
- **Authenticated Redis**, hardened containers (cap-drop, read-only rootfs,
  non-root users), append-only **audit log**, and **secret redaction** in logs.
- **Strict env validation** (`@t3-oss/env-nextjs`) — production boot fails fast
  if any required variable is missing.

See **[SECURITY.md](./SECURITY.md)** for the disclosure policy, accepted
dependency advisories, and cryptographic choices.

### Hardening your hosting environment

The app field-encrypts the most sensitive data and ships hardened containers,
but a few protections live in the **hosting environment**, not the code. They
matter most because you're handling real people's data (logins, emails,
recruitment applications). Here's what to do and *why*, for **AWS**, **Azure**,
and a **self-hosted** server.

> **Rule of thumb:** only **80/443** should ever be reachable from the internet.
> The database, cache, pooler, metrics, and dashboards all stay private.

1. **Encrypt the disks at rest.** Your database, Redis (which persists tokens
   and job data), and backups all live on disk; encryption makes a stolen disk,
   snapshot, or decommissioned drive useless.
   - *AWS:* enable account-level EBS encryption; use encrypted RDS + snapshots.
   - *Azure:* managed disks are encrypted by default; add a customer-managed key
     in Key Vault for stronger control.
   - *Self-hosted:* full-disk encryption (LUKS) on the data partition.

2. **Lock down the firewall / network.** Postgres, Redis, and PgBouncer trust
   their private network and must never face the internet.
   - *AWS:* a Security Group allowing only 80/443; put RDS / ElastiCache in a
     private subnet.
   - *Azure:* an NSG allowing only 80/443 inbound; keep the database on a private
     endpoint / VNet.
   - *Self-hosted:* `ufw default deny incoming; ufw allow 80; ufw allow 443;
     ufw allow <ssh-port>`. If you front it with Cloudflare, also restrict the
     origin to Cloudflare's IP ranges.

3. **Force HTTPS, strictly.** TLS protects every login and token in transit.
   - *AWS:* terminate TLS at an ALB with an ACM cert; redirect 80→443.
   - *Azure:* Application Gateway / Front Door with a managed cert; "HTTPS only."
   - *Self-hosted:* Caddy provisions TLS per `TLS_MODE` and sends HSTS — default
     `acme` (Let's Encrypt). Behind Cloudflare (where ACME can't validate), use
     `TLS_MODE=custom` with a Cloudflare Origin cert and set SSL/TLS to
     **Full (strict)** and "Always Use HTTPS."

4. **Encrypt the DB connection (or keep it on a trusted network).** By default
   the app talks to Postgres over the private Docker network — fine on one host,
   a risk once the database is on a separate machine.
   - *AWS:* RDS with `rds.force_ssl=1` and `?sslmode=verify-full` (+ CA bundle).
   - *Azure:* Azure Database for PostgreSQL (TLS enforced); `sslmode=verify-full`.
   - *Self-hosted:* same-host private bridge is an acceptable boundary; across
     hosts, enable server TLS and `sslmode=verify-full`.

5. **Keep secrets in a managed store, not a plaintext file.** A secret store
   adds access control, rotation, and an audit trail.
   - *AWS:* Secrets Manager / SSM Parameter Store (SecureString) injected at
     start; give the instance an IAM role.
   - *Azure:* Key Vault read via a managed identity.
   - *Self-hosted:* Docker secrets or a SOPS-encrypted env file. At minimum
     `chmod 600` your production `.env`, own it as `root`, exclude it from
     backups.

6. **Encrypt, off-site, and test your backups.** A backup is a full copy of
   everyone's data.
   - *AWS:* encrypted RDS snapshots, or the bundled backup → S3 with SSE +
     versioning.
   - *Azure:* Azure Backup, or the bundled backup → encrypted Blob Storage.
   - *Self-hosted:* the bundled **age-encrypted** `pg_dump` → `rclone` job (the
     `backup` profile). Keep the age **private** key offline and **test a
     restore** periodically.

7. **Rotate credentials and use least privilege.** Rotation limits how long a
   leaked secret is useful; least privilege limits its blast radius.
   - Rotate `AUTH_SECRET`, `SHARE_TOKEN_SECRET`, `TOKEN_ENCRYPTION_KEY`, the
     Postgres/Redis passwords, and provider keys on a schedule.
   - The app connects as a non-superuser Postgres role — keep it that way.

8. **Patch and scan.** Most real compromises use known, already-patched bugs.
   - *AWS / Azure:* enable image scanning (ECR / ACR) and managed OS patching.
   - *Self-hosted:* `unattended-upgrades`, keep Docker updated, watch the repo's
     CI scans (Trivy + `npm audit`), and lock down SSH (key-only, no root login).

---

## Project layout

```
src/
├── app/             # Next.js App Router — pages + API routes
├── components/      # React UI (incl. dashboard widgets)
├── server/          # server-side logic
│   ├── api/         #   tRPC routers
│   ├── auth/        #   Auth.js config
│   ├── ingestion/   #   Blizzard / WCL / Raider.IO sync + BullMQ worker
│   ├── monitoring/  #   metrics + Loki queries
│   ├── recruitment/ #   public recruitment forms
│   ├── security/    #   CSP, headers, rate limit, audit log
│   └── …            #   calendar, crypto, discord, guild-auth, professions
├── lib/             # db / redis / logger singletons
└── env.ts           # zod-validated environment contract

addon/        # in-game World of Warcraft addon
companion/    # desktop companion that uploads addon exports
ops/          # monitoring configs (Prometheus, Loki, Promtail, Grafana)
prisma/       # schema + migrations
Setup/        # ← self-contained PRODUCTION deployment package
docs/         # design notes, runbooks, research
```

---

## License

[GNU AGPL-3.0-or-later](./LICENSE.md). This is network-server software: if you
run a modified version and let others use it over a network, AGPL section 13
requires you to offer them your modified source.

Releases up to and including **v1.0.35** were published under the MIT license and
remain available under MIT; **all releases after v1.0.35 are AGPL-3.0-or-later.**
