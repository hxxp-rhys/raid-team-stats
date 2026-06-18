#!/usr/bin/env sh
# Daily encrypted Postgres backup.
#
# Pipeline:
#   pg_dump | age --recipient $BACKUP_AGE_PUBKEY | rclone copyto $RCLONE_REMOTE
#
# Required env:
#   POSTGRES_HOST          (defaults to "postgres")
#   POSTGRES_USER          (defaults to "raid_team_stats")
#   POSTGRES_PASSWORD
#   POSTGRES_DB            (defaults to "raid_team_stats")
#   BACKUP_AGE_PUBKEY      age public key (the private key stays offline)
#   RCLONE_REMOTE          remote path, e.g. "b2:rts-backups/prod"
#
# Restore:
#   rclone copyto <remote>/<file> -                 \
#     | age -d -i ~/.age/backup-key.txt              \
#     | psql -h localhost -U raid_team_stats raid_team_stats

set -eu

HOST="${POSTGRES_HOST:-postgres}"
USER="${POSTGRES_USER:-raid_team_stats}"
DB="${POSTGRES_DB:-raid_team_stats}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="raid-team-stats-${STAMP}.sql.age"

if [ -z "${POSTGRES_PASSWORD:-}" ] \
    || [ -z "${BACKUP_AGE_PUBKEY:-}" ] \
    || [ -z "${RCLONE_REMOTE:-}" ]; then
  echo "backup: missing one of POSTGRES_PASSWORD, BACKUP_AGE_PUBKEY, RCLONE_REMOTE"
  exit 2
fi

export PGPASSWORD="$POSTGRES_PASSWORD"

echo "backup: dumping $DB from $HOST as $USER → $FILENAME"
pg_dump --host="$HOST" --username="$USER" --no-owner --no-privileges --format=plain "$DB" \
  | age --recipient "$BACKUP_AGE_PUBKEY" \
  | rclone rcat "${RCLONE_REMOTE}/${FILENAME}" \
      --retries 5 \
      --retries-sleep 30s

# Trim remote retention to ~30 days (keeps daily snapshots + the most recent).
# rclone delete with --min-age applied via prefix listing.
rclone --min-age 30d delete "${RCLONE_REMOTE}/" --include "raid-team-stats-*.sql.age" || true

echo "backup: done at $(date -u)"
