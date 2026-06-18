# Deploying raid-team-stats

This folder is a **self-contained production deployment**. Copy it to your
server, edit **one file** (`.env`), and run **one command**. It pulls a
pre-built image — there is nothing to compile.

The whole thing is three steps:

```bash
cp .env.example .env && ./generate-secrets.sh    # 1. configure
./init-storage.sh                                # 2. prepare storage
docker compose up -d                             # 3. launch
```

The rest of this guide explains each step and the few values only you can
provide (your domain and API keys).

---

## What you get

A single `docker compose up -d` brings up the full stack:

| Component | What it does |
|-----------|--------------|
| **Caddy** | Reverse proxy + **automatic HTTPS** (Let's Encrypt). The only thing exposed to the internet (ports 80/443). |
| **Web** | The Next.js app. Runs database migrations automatically on start. |
| **Worker** | Background ingestion (Blizzard / Warcraft Logs / Raider.IO syncing). |
| **PostgreSQL + PgBouncer** | Database and connection pooler. |
| **Redis** | Cache + job queue (password-protected). |
| **Monitoring** | Prometheus + Loki + Promtail + Grafana. **On by default.** |

> **Security & monitoring stack — on by default, opt out anytime.**
> The four monitoring services collect metrics and logs and ship preconfigured
> Grafana dashboards. They bind to **localhost only** (never the internet). If
> you don't want them, set `COMPOSE_PROFILES=` (empty) in `.env` — see
> [Monitoring](#monitoring) below.

---

## Prerequisites

- A **Linux server** (2 GB RAM minimum) with **Docker Engine** and the
  **Docker Compose plugin** installed.
- A **domain name** you control, with a **DNS A record** (and AAAA if you use
  IPv6) pointing at the server's public IP.
- Ports **80** and **443** open to the internet. Everything else stays private.

> **Note — pulling the image.** The app image is hosted on GitHub Container
> Registry. If the pull fails with "denied" / "unauthorized", the package is
> private — authenticate once with a GitHub token that has `read:packages`:
> `echo <TOKEN> | docker login ghcr.io -u <your-github-username> --password-stdin`

---

## Step 1 — Get the files onto your server

Copy **this `Setup` folder** to your server (e.g. to `/opt/raidstats`). Either
clone the repo and use the `Setup/` subfolder, or `scp` the folder across:

```bash
# option A: clone, then work inside Setup/
git clone https://github.com/hxxp-rhys/raid-stats.git
cd raid-stats/Setup

# option B: copy just this folder from your machine
scp -r ./Setup you@your-server:/opt/raidstats
```

Make the helper scripts executable:

```bash
chmod +x generate-secrets.sh init-storage.sh
```

---

## Step 2 — Register your API credentials

The app talks to Blizzard and Warcraft Logs on your behalf, and sends email.
Create these before you fill in `.env`. Replace `raid.example.com` with your
real domain everywhere.

**Battle.net (Blizzard)** — https://develop.battle.net/access/clients
- Create a client. Add this **Redirect URL**:
  `https://raid.example.com/bnet-login-callback`
- Copy the **Client ID** and **Client Secret**.

**Warcraft Logs** — https://www.warcraftlogs.com/api/clients/
- Create a client (v2 API). Add this **Redirect URL**:
  `https://raid.example.com/wcl-callback`
- Copy the **Client ID** and **Client Secret**.

**Email (SMTP)** — any provider (e.g. a transactional email service). You need
the host, port, username, password, and a "from" address. Used for account
verification, password resets, and raid reminders.

> **Optional:** Discord (raid-calendar integration) and Raider.IO (works
> without a key). Leave those blank to skip them.

---

## Step 3 — Configure `.env`

`.env` is the **only file you edit**. Create it and let the helper generate
every secret and password for you:

```bash
cp .env.example .env
./generate-secrets.sh
```

`generate-secrets.sh` fills in `AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`,
`METRICS_TOKEN`, the Postgres/Redis/Grafana passwords, and more. Then open
`.env` and set the handful of values only you know:

| Setting | Value |
|---------|-------|
| `APP_HOST` | Your hostname only, e.g. `raid.example.com` (no `https://`). |
| `APP_URL` | `https://raid.example.com` |
| `AUTH_URL` | Same as `APP_URL`. |
| `BLIZZARD_CLIENT_ID` / `BLIZZARD_CLIENT_SECRET` | From Step 2. |
| `BATTLENET_REDIRECT_URI` | `https://raid.example.com/bnet-login-callback` |
| `WCL_CLIENT_ID` / `WCL_CLIENT_SECRET` | From Step 2. |
| `WCL_REDIRECT_URI` | `https://raid.example.com/wcl-callback` |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | From Step 2. |

> Every line in `.env` is marked `[REQUIRED]` or `[OPTIONAL]`. If a required
> value is missing, the stack stops and tells you which one.

---

## Step 4 — Prepare storage

By default all data is stored in `./data` next to the compose file. To put it
on a specific disk instead, set `DATA_DIR` in `.env` to an absolute path (e.g.
`DATA_DIR=/srv/raidstats/data`).

Then create the directories with the correct permissions:

```bash
sudo ./init-storage.sh
```

> **Why `sudo`?** Prometheus, Loki, and Grafana run as non-root users and need
> to own their data directories. The script sets that up. If you skip it on a
> Linux host, those three monitoring services fail to start with "permission
> denied". (Run it again any time you change `DATA_DIR`.)

---

## Step 5 — Launch

```bash
docker compose up -d
```

This pulls the image, starts the database, **runs migrations automatically**,
then starts the app, worker, and monitoring. The first start takes a minute
while Caddy obtains your TLS certificate.

Watch it come up:

```bash
docker compose ps          # all services should become "healthy"/"running"
docker compose logs -f web # follow the app (migrations run here on boot)
```

---

## Step 6 — Verify

```bash
curl -fsS https://raid.example.com/api/health   # → 200 OK
```

Then open `https://raid.example.com` in a browser — you should get a valid
certificate and the app. Create your account, then make yourself a platform
admin by adding your email to `ADMIN_EMAILS` in `.env` and running
`docker compose up -d web`.

---

## Monitoring

Prometheus, Loki, Promtail, and Grafana run **by default**. The dashboards are
preconfigured. All four bind to **127.0.0.1 only** — they are never exposed to
the internet. Reach Grafana through an SSH tunnel from your machine:

```bash
ssh -L 3001:localhost:3001 you@your-server
# then open http://localhost:3001  (user/pass: GRAFANA_ADMIN_USER / _PASSWORD)
```

**To opt out of monitoring**, set this in `.env` and re-launch:

```ini
COMPOSE_PROFILES=
```

```bash
docker compose up -d --remove-orphans
```

> **Note — `METRICS_TOKEN` is still required even with monitoring off**, because
> the app validates it at boot. `generate-secrets.sh` already set it.
>
> **Note — changing `METRICS_TOKEN` later:** Prometheus reads it once at
> startup, so after changing it you must **recreate** Prometheus, not restart
> it: `docker compose up -d prometheus`.

---

## Backups (optional)

A nightly, **age-encrypted** `pg_dump` uploaded off-host via `rclone` is
included but **off by default**. To enable it:

1. Generate an age key pair **offline** (`age-keygen`) and keep the **private**
   key off this server.
2. Configure an `rclone` remote for your object storage.
3. In `.env` set `BACKUP_AGE_PUBKEY`, `RCLONE_REMOTE`, and add `backup` to the
   profiles:
   ```ini
   COMPOSE_PROFILES=monitoring,backup
   ```
4. `docker compose up -d`

It runs at 04:00 server time and prunes remote copies older than 30 days.

---

## Updating

```bash
docker compose pull        # fetch the latest image
docker compose up -d       # recreate changed containers (migrations auto-run)
```

To pin an exact version instead of always taking the latest, **uncomment** the
`RTS_IMAGE` line in `.env` and set it to a specific tag (e.g.
`ghcr.io/hxxp-rhys/raid-stats:sha-2b9bcf0`). While it stays commented, the
default `:latest` is used.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `The "APP_HOST" variable is not set` | `APP_HOST` is missing/blank in `.env`. Set it to your hostname. |
| `... is required — set it in .env` on `up` | A required value (`POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `METRICS_TOKEN`) is blank. Run `./generate-secrets.sh`. |
| Image pull `denied` / `unauthorized` | Package is private — `docker login ghcr.io` (see [Prerequisites](#prerequisites)). |
| Prometheus/Loki/Grafana keep restarting, "permission denied" | You didn't run `sudo ./init-storage.sh` (or changed `DATA_DIR` without re-running it). |
| TLS certificate won't issue | DNS A record must point at this server and ports 80/443 must be open. Check `docker compose logs caddy`. |
| Grafana panels show "no data" after a token change | Recreate Prometheus: `docker compose up -d prometheus`. |
| Battle.net login fails (`invalid_grant`) | `AUTH_URL` must equal `APP_URL`, and the redirect URI in `.env` must match the one registered at Battle.net exactly. |

---

## Reference: what runs and where

| Service | Container | Exposed | Profile |
|---------|-----------|---------|---------|
| Caddy | `rts-caddy` | 80, 443 (public) | always |
| Web | `rts-web` | via Caddy only | always |
| Worker | `rts-worker` | — | always |
| Postgres | `rts-postgres` | internal | always |
| PgBouncer | `rts-pgbouncer` | internal | always |
| Redis | `rts-redis` | internal | always |
| Prometheus | `rts-prometheus` | 127.0.0.1:9090 | `monitoring` |
| Loki | `rts-loki` | 127.0.0.1:3100 | `monitoring` |
| Promtail | `rts-promtail` | — | `monitoring` |
| Grafana | `rts-grafana` | 127.0.0.1:3001 | `monitoring` |
| Backup | `rts-backup` | — | `backup` |

All persistent data lives under `DATA_DIR` (default `./data`).
