#!/usr/bin/env bash
# Encrypted Postgres backup (security finding L5).
#
# pg_dump (inside the rts-postgres container) -> age-encrypted with a
# PUBLIC key (the matching private key stays OFFLINE, never on the VPS,
# so a host compromise cannot read the backups) -> timestamped file ->
# pruned -> optional off-host copy.
#
# Operator setup (one time, OFF the server):
#   age-keygen -o rts-backup-key.txt        # keep this file OFFLINE
#   # the "Public key: age1..." line -> RTS_BACKUP_AGE_RECIPIENT
# On the VPS:
#   apt-get install -y age
#   /etc/cron.d/rts-backup:
#     RTS_BACKUP_AGE_RECIPIENT=age1xxxxxxxx
#     0 3 * * * root /usr/local/sbin/backup.sh >> /var/log/rts-backup.log 2>&1
# Restore (off-server, with the offline key):
#   age -d -i rts-backup-key.txt rts-YYYYMMDD...sql.age \
#     | docker exec -i rts-postgres psql -U "$PG_USER" -d "$PG_DB"
set -euo pipefail

RECIP="${RTS_BACKUP_AGE_RECIPIENT:?set RTS_BACKUP_AGE_RECIPIENT to the age public key}"
OUT_DIR="${RTS_BACKUP_DIR:-/root/backups}"
KEEP="${RTS_BACKUP_KEEP:-14}"
PG_CONT="${RTS_PG_CONTAINER:-rts-postgres}"
PG_USER="${RTS_PG_USER:-postgres}"
PG_DB="${RTS_PG_DB:-postgres}"

command -v age >/dev/null || { echo "age not installed (apt-get install -y age)"; exit 1; }
mkdir -p "$OUT_DIR"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
file="$OUT_DIR/rts-$ts.sql.age"

docker exec "$PG_CONT" pg_dump -U "$PG_USER" -d "$PG_DB" \
  --no-owner --clean --if-exists | age -r "$RECIP" > "$file"

# A truncated/empty dump must never silently replace good backups.
if [ ! -s "$file" ] || [ "$(stat -c%s "$file")" -lt 256 ]; then
  echo "backup looks empty/short — aborting, not pruning"; rm -f "$file"; exit 1
fi
echo "wrote $file ($(stat -c%s "$file") bytes)"

# retention: keep the newest $KEEP
ls -1t "$OUT_DIR"/rts-*.sql.age 2>/dev/null | tail -n +"$((KEEP + 1))" \
  | xargs -r rm -f

# optional off-host (configure an rclone remote first):
if [ -n "${RTS_BACKUP_RCLONE:-}" ]; then
  rclone copy "$file" "$RTS_BACKUP_RCLONE" && echo "off-host -> $RTS_BACKUP_RCLONE"
fi
