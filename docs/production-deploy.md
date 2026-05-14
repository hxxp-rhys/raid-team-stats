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

The default `docker-compose.yml` already runs a complete observability
stack (Prometheus + Loki + Promtail + Grafana). The same images and
configs work in production — copy the `prometheus`, `loki`, `promtail`,
and `grafana` services into `docker-compose.prod.yml`, then put Grafana
behind Caddy basic auth (snippet below).

### What's instrumented

- **HTTP traffic**: `rts_http_request_duration_seconds` (histogram with
  `method`, `route_class`, `status_class`) and `rts_http_rate_limited_total`
  emitted from `src/proxy.ts` on every request the proxy matcher sees.
  Health/ready/metrics endpoints bypass the matcher and are not counted.
- **Auth**: `rts_auth_events_total{event=login_success|login_failure|
  mfa_required|mfa_failure}` from the Credentials provider.
- **BullMQ**: `rts_jobs_total{queue,status}`, `rts_job_duration_seconds`
  histogram, and `rts_queue_depth{queue,state}` gauge refreshed every 15s
  from the worker process via QueueEvents.
- **Ingestion**: `rts_upstream_requests_total{source,status_class}` and
  `rts_upstream_budget_remaining{source}` (wired in when each client opts
  in — Phase 8.x).
- **Node runtime**: `rts_process_*` defaults from prom-client (event-loop
  lag, GC pause, heap, file descriptors).

### Endpoints

- `/api/metrics` — Prometheus exposition format. Two auth paths:
  1. `Authorization: Bearer $METRICS_TOKEN` for the Prometheus container
     (substituted into the prometheus.yml at container start by
     `ops/prometheus/entrypoint.sh`).
  2. Authenticated platform admin session for spot-checks in a browser.
- `/api/health` (liveness) and `/api/ready` (Postgres + Redis check) —
  used by Docker healthchecks and external uptime monitors.

### Caddy snippet — put Grafana behind basic auth + your domain

```caddyfile
grafana.${APP_HOST} {
  basicauth /* {
    admin <bcrypt-hash-from `caddy hash-password`>
  }
  reverse_proxy grafana:3000
}
```

Or expose Grafana under a path on the main domain:

```caddyfile
${APP_HOST} {
  handle_path /grafana/* {
    basicauth /* {
      admin <bcrypt-hash>
    }
    reverse_proxy grafana:3000
  }
  reverse_proxy web:3000
}
```

The Grafana container's `GF_SERVER_ROOT_URL` env should be set to match
the chosen URL if you go with the sub-path approach.

### Log shipping

Promtail tails the Docker socket and ships every container's stdout/stderr
to Loki with the container name as a label. Caddy's JSON access logs are
auto-parsed and indexed by `status`, `method`, `host`, `remote_ip`. The
included `RTS — Overview` dashboard surfaces:

- HTTP request rate + p95 latency per route class
- Rate-limit denials per hour
- Auth event timeline
- Queue depth + job throughput
- Caddy 5xx tail + app-level pino errors

### k6 load test

The k6 thresholds in `tests/load/k6-auth.js` are tuned for a local docker
compose. Re-tune them against production before treating threshold breaches
as alerts.

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
