# Production deploy

Single-host deploy via `docker-compose.prod.yml` against a fresh VPS
(Hetzner / Fly.io machine / DigitalOcean). For multi-host, take the same
images and lift them into your orchestrator.

## Prereqs

- Linux host with Docker Engine 24+ and Compose v2.
- DNS A/AAAA record pointing your `APP_HOST` (e.g. `raid.example.com`) at
  the host's public IP.
- 2 GB RAM minimum. 4 GB recommended once Tier A is syncing 25+ characters.

## First-time setup

```bash
# Clone + create the prod env file (never commit this).
git clone https://github.com/hxxp-rhys/raid-stats.git /opt/raid-stats
cd /opt/raid-stats
cp .env.example .env.prod
$EDITOR .env.prod
```

Required values (`.env.prod`):

| Variable | Notes |
|----------|-------|
| `APP_HOST` | Public hostname Caddy will issue a cert for. |
| `APP_URL` | `https://${APP_HOST}` |
| `POSTGRES_PASSWORD` | Strong random (`openssl rand -base64 32`). |
| `AUTH_SECRET` | `openssl rand -base64 48`. |
| `TOKEN_ENCRYPTION_KEY` | Exactly 32 bytes base64-encoded (`openssl rand -base64 32`). |
| `BLIZZARD_CLIENT_ID` / `_SECRET` / `BATTLENET_REDIRECT_URI` | Registered Battle.net OAuth app, redirect URI `https://${APP_HOST}/bnet-login-callback`. |
| `WCL_CLIENT_ID` / `_SECRET` / `WCL_REDIRECT_URI` | Warcraft Logs client, redirect URI `https://${APP_HOST}/wcl-callback`. |
| `SMTP_*` | Outbound email transport for verification + password-reset. |
| `RATE_LIMIT_TRUST_PROXY` | `true` (we're behind Caddy). |

Then bring it up:

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec web npx prisma migrate deploy
```

Caddy will obtain a Let's Encrypt cert for `APP_HOST` on first request. Hit
`https://${APP_HOST}/api/health` to confirm.

## Backups

The `backup` service is in the optional `backup` profile. To enable:

1. Generate an age keypair OFFLINE (do not keep the private key on the
   server):
   ```bash
   age-keygen -o ~/.age/backup-key.txt
   ```
   The output's `# public key:` line is `BACKUP_AGE_PUBKEY`.
2. Configure rclone for your object store (B2, S3, Wasabi…):
   ```bash
   rclone config
   ```
3. Add to `.env.prod`:
   ```
   BACKUP_AGE_PUBKEY=age1...
   RCLONE_REMOTE=b2:rts-backups/prod
   ```
4. Start the backup container:
   ```bash
   docker compose -f docker-compose.prod.yml --profile backup up -d backup
   ```

Backups run at 04:00 UTC nightly. Restore procedure:

```bash
rclone copyto $RCLONE_REMOTE/<file>.sql.age - \
  | age -d -i ~/.age/backup-key.txt \
  | psql -h localhost -U raid_team_stats raid_team_stats
```

## Observability

- All container logs go to stdout in line-delimited JSON (pino). Configure
  your host's log aggregator (Loki, Vector, Datadog, etc.) to pull from
  Docker's JSON log driver.
- `/api/health` is liveness; `/api/ready` checks Postgres + Redis.
- BullMQ job state lives in Redis; mount Bull Board behind admin auth in a
  follow-up if you want a job UI.

## Upgrades

```bash
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml exec web npx prisma migrate deploy
```

Caddy reload is automatic on config change.

## Rolling back

```bash
git checkout <previous-sha>
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

If the rollback crosses a Prisma migration boundary, restore the DB from the
nearest backup before bringing the app back up.

## Security notes

- All containers run with `cap_drop: ALL` and `no-new-privileges:true`.
- The `web` container is `read_only: true` with `/tmp` and `/app/.next/cache`
  on tmpfs — code can't write to its own filesystem at runtime.
- `pgbouncer` uses SCRAM-SHA-256 auth and transaction-pool mode.
- Caddy auto-renews TLS certs and emits HSTS preload headers.
- See [`SECURITY.md`](../SECURITY.md) for the disclosure policy and the
  list of accepted upstream advisories.
