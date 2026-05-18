# infra/

Operational scripts for the production VPS. Source of truth — the live
copies are deployed out of band (not part of the Next build).

## cloudflare-firewall-sync.sh

Locks the public web ports so **only Cloudflare can reach 80/443**
(security finding **H2** — the origin must not be hittable directly,
bypassing Cloudflare's WAF/rate-limit and the per-IP audit).

**Why not UFW:** Caddy runs as a Docker container. Docker programs its
own iptables DNAT and **bypasses UFW** for published ports, so UFW
`allow/deny 80,443` rules would do nothing. The script instead manages
the **`DOCKER-USER`** chain (the Docker-supported filter hook) with an
`ipset` of Cloudflare's published ranges. Port **22/SSH is never
touched** (it is not Dockerized and is out of scope).

Fail-safe: Cloudflare's `ips-v4`/`ips-v6` are fetched and strictly
validated; on any fetch/sanity failure the firewall is left unchanged
(never wiped open or shut). The ipset is swapped atomically.

### Deploy

```
apt-get update && apt-get install -y ipset
install -m 0750 -o root -g root cloudflare-firewall-sync.sh /usr/local/sbin/
```

`/etc/cron.d/cloudflare-firewall-sync`:

```
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
0 4 * * * root /usr/local/sbin/cloudflare-firewall-sync.sh >> /var/log/cf-fw-sync.log 2>&1
@reboot   root sleep 60; /usr/local/sbin/cloudflare-firewall-sync.sh >> /var/log/cf-fw-sync.log 2>&1
```

Daily 04:00 + at boot (Docker recreates `DOCKER-USER` empty on a
**daemon** restart/reboot — restarting individual containers, as our
deploys do, does NOT clear it).

### Rollback

`iptables -F DOCKER-USER; iptables -A DOCKER-USER -j RETURN` (and the
same with `ip6tables`) reopens 80/443 immediately.

## Supply-chain + backups (finding L5)

**Dependency / image / config scanning** — `.github/dependabot.yml`
(weekly npm + actions + docker PRs) and `.github/workflows/security.yml`
(`npm audit --audit-level=high` + Trivy fs scan for vuln/secret/
misconfig). Shipped **informational** so it can't block the branch
while findings are triaged; to **enforce**, drop `continue-on-error`
from the npm-audit step and set Trivy `exit-code: "1"`. (These run in
GitHub Actions only — no runtime/prod impact.)

**Encrypted backups** — `backup.sh`: `pg_dump` inside `rts-postgres`,
`age`-encrypted with a **public** key (private key kept OFFLINE, never
on the VPS — a host compromise can't decrypt them), timestamped,
retained, optional off-host via rclone. Operator steps:

```
# off-server, once:
age-keygen -o rts-backup-key.txt          # store OFFLINE only
# on the VPS:
apt-get install -y age
install -m 0750 -o root -g root backup.sh /usr/local/sbin/
# /etc/cron.d/rts-backup:
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
RTS_BACKUP_AGE_RECIPIENT=age1xxxxxxxx
RTS_PG_USER=<from DATABASE_URL>
RTS_PG_DB=<from DATABASE_URL>
0 3 * * * root /usr/local/sbin/backup.sh >> /var/log/rts-backup.log 2>&1
```

Restore (off-server, with the offline key):
`age -d -i rts-backup-key.txt rts-*.sql.age | docker exec -i rts-postgres psql -U <user> -d <db>`.
Test a restore into a throwaway DB after first setup.

> Not auto-wired: needs the operator to generate the age key and add
> the cron (the private key must never live on the server).
