#!/usr/bin/env sh
# ---------------------------------------------------------------------------
# generate-secrets.sh — fill the secret/password lines in ./.env
#
# Creates ./.env from ./.env.example if needed, then generates every secret
# and password with openssl and writes them in. Re-run safe: a line that
# already has a value is left untouched (it never overwrites your secrets).
#
#   sh ./generate-secrets.sh
#
# Passwords that get embedded in connection URLs (Postgres, Redis) use hex so
# they are always URL-safe.
# ---------------------------------------------------------------------------
set -eu

cd "$(dirname "$0")"

if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: openssl is required but was not found on PATH." >&2
  exit 1
fi

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "Created .env from .env.example."
  else
    echo "ERROR: neither .env nor .env.example found in $(pwd)." >&2
    exit 1
  fi
fi

# set_secret KEY VALUE — fill KEY's value in .env only if it is currently blank.
set_secret() {
  key="$1"
  value="$2"
  current="$(grep -E "^${key}=" .env | head -n1 | sed "s/^${key}=//" || true)"
  if [ -n "${current}" ]; then
    echo "  ${key} already set — skipping"
    return
  fi
  if grep -qE "^${key}=" .env; then
    awk -v k="${key}" -v v="${value}" \
      'BEGIN{done=0} { if (!done && $0 ~ "^" k "=") { print k "=" v; done=1 } else { print } }' \
      .env > .env.tmp && mv .env.tmp .env
    echo "  ${key} generated"
  else
    printf '%s=%s\n' "${key}" "${value}" >> .env
    echo "  ${key} generated (appended)"
  fi
}

echo "Generating secrets into .env ..."
set_secret AUTH_SECRET            "$(openssl rand -base64 48)"
set_secret SHARE_TOKEN_SECRET     "$(openssl rand -base64 48)"
set_secret TOKEN_ENCRYPTION_KEY   "$(openssl rand -base64 32)"
set_secret METRICS_TOKEN          "$(openssl rand -hex 32)"
set_secret POSTGRES_PASSWORD      "$(openssl rand -hex 24)"
set_secret REDIS_PASSWORD         "$(openssl rand -hex 24)"
set_secret GRAFANA_ADMIN_PASSWORD "$(openssl rand -hex 16)"

echo ""
echo "Done. Secrets written to .env."
echo "Still TODO by hand in .env:  APP_HOST, APP_URL, AUTH_URL,"
echo "  BLIZZARD_CLIENT_ID/SECRET, WCL_CLIENT_ID/SECRET, and the SMTP_* values."
