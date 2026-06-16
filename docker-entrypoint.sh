#!/bin/sh
set -e

# Production entrypoint. Applies pending Prisma migrations before launching the
# container's command (web server OR worker), then hands off to it.
#
#   RUN_MIGRATIONS=false   Skip migrations. Set this on the WORKER so the web
#                          container is the single place migrations run.
#   MIGRATE_DATABASE_URL   Optional DIRECT database URL used ONLY for migrations.
#                          Set this to bypass a transaction-pooled PgBouncer,
#                          which can't run Prisma's migration session. Falls back
#                          to DATABASE_URL when unset.

if [ "${RUN_MIGRATIONS:-true}" != "false" ]; then
  echo "[entrypoint] applying database migrations (prisma migrate deploy)..."
  DATABASE_URL="${MIGRATE_DATABASE_URL:-$DATABASE_URL}" node_modules/.bin/prisma migrate deploy

  # One-time PII encryption backfill (F11). Encrypts any pre-existing PLAINTEXT
  # PII (display names, avatars, recruitment answers) so old rows match the
  # transparent field encryption. Idempotent — already-encrypted rows are
  # skipped — but it re-saves every row, so keep it OFF for normal boots:
  #   RUN_PII_BACKFILL=true   Run ONLY on the first deploy that turns on field
  #                           encryption, then unset it.
  # Runs here (the single migration runner) so it can't race a second replica,
  # and AFTER migrations so the schema is in place.
  if [ "${RUN_PII_BACKFILL:-false}" = "true" ]; then
    echo "[entrypoint] running one-time PII encryption backfill (F11)..."
    node_modules/.bin/tsx scripts/backfill-pii-encryption.ts \
      || echo "[entrypoint] WARNING: PII backfill failed — run it manually before serving sensitive reads."
  fi
fi

exec "$@"
