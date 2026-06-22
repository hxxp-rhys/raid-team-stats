#!/usr/bin/env sh
# ---------------------------------------------------------------------------
# init.sh — one-shot pre-deployment init for the production stack.
#
# Everything you need before `docker compose up`, in one command:
#   1. creates ./.env from ./.env.example (if it doesn't exist yet),
#   2. generates every secret + password and writes them into ./.env,
#   3. creates the data directory tree with the ownership each container needs
#      (and locks down the TLS cert dir).
#
# Re-run safe: existing secrets are never overwritten, and mkdir/chown are
# idempotent. Run it again whenever you change DATA_DIR or add a custom cert.
#
#   sh ./init.sh        (use sudo if chown is denied)
#
# Then set the by-hand values in ./.env — APP_HOST, APP_URL, AUTH_URL, and your
# Blizzard / Warcraft Logs / SMTP credentials — and start the stack:
#
#   docker compose up -d
#
# Passwords embedded in connection URLs (Postgres, Redis) use hex so they are
# always URL-safe.
# ---------------------------------------------------------------------------
set -eu

cd "$(dirname "$0")"

if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: openssl is required but was not found on PATH." >&2
  exit 1
fi

# ── 1. .env ─────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "Created .env from .env.example."
  else
    echo "ERROR: neither .env nor .env.example found in $(pwd)." >&2
    exit 1
  fi
fi

# set_secret KEY VALUE — fill KEY's value in .env only if it is currently blank
# (so re-running never clobbers a secret you already have).
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

# read_env_var KEY DEFAULT — read KEY's value from .env, stripping an inline
# " # comment", surrounding quotes, and trailing whitespace. Falls back to
# DEFAULT when the line is blank.
read_env_var() {
  _key="$1"; _val="$2"
  if [ -f .env ]; then
    _v="$(grep -E "^${_key}=" .env | head -n1 | sed "s/^${_key}=//")"
    _v="$(printf '%s' "${_v}" | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" -e 's/[[:space:]]*$//')"
    [ -n "${_v}" ] && _val="${_v}"
  fi
  printf '%s' "${_val}"
}

# ── 2. secrets ───────────────────────────────────────────────────────────────
echo "Generating secrets into .env ..."
set_secret AUTH_SECRET            "$(openssl rand -base64 48)"
set_secret SHARE_TOKEN_SECRET     "$(openssl rand -base64 48)"
set_secret TOKEN_ENCRYPTION_KEY   "$(openssl rand -base64 32)"
set_secret METRICS_TOKEN          "$(openssl rand -hex 32)"
set_secret POSTGRES_PASSWORD      "$(openssl rand -hex 24)"
set_secret REDIS_PASSWORD         "$(openssl rand -hex 24)"
set_secret GRAFANA_ADMIN_PASSWORD "$(openssl rand -hex 16)"

# ── 3. storage ───────────────────────────────────────────────────────────────
# The bundled containers run as non-root users; a freshly created bind-mount dir
# is root-owned, so each service must own its own data dir or it can't start.
# Caddy is the mirror image: it runs as root but with cap_drop:ALL (no
# CAP_DAC_OVERRIDE), so its dirs must be owned by uid 0.
DATA_DIR="$(read_env_var DATA_DIR ./data)"
echo ""
echo "Preparing storage at DATA_DIR=${DATA_DIR} ..."

mkdir -p \
  "${DATA_DIR}/postgres" \
  "${DATA_DIR}/redis" \
  "${DATA_DIR}/caddy" \
  "${DATA_DIR}/caddy-config" \
  "${DATA_DIR}/certs" \
  "${DATA_DIR}/prometheus" \
  "${DATA_DIR}/loki" \
  "${DATA_DIR}/promtail-positions" \
  "${DATA_DIR}/grafana" \
  "${DATA_DIR}/backup-staging"

# Container users that must own their data dir (uid:gid):
#   Prometheus 65534 (nobody)   Loki 10001   Grafana 472   Caddy 0 (root)
# Caddy runs as root but with cap_drop:ALL, so without owning its store it gets
# "mkdir /data/caddy: permission denied" and can never obtain a TLS cert.
chown_or_warn() {
  uid="$1"
  dir="$2"
  if chown -R "${uid}:${uid}" "${dir}" 2>/dev/null; then
    echo "  set owner ${uid} -> ${dir}"
  else
    echo "  WARN: could not chown ${dir} to ${uid}. Re-run with sudo, or that" >&2
    echo "        service may fail to start (no TLS for Caddy; no monitoring)." >&2
  fi
}

chown_or_warn 65534 "${DATA_DIR}/prometheus"
chown_or_warn 10001 "${DATA_DIR}/loki"
chown_or_warn 472   "${DATA_DIR}/grafana"
chown_or_warn 0     "${DATA_DIR}/caddy"
chown_or_warn 0     "${DATA_DIR}/caddy-config"
chown_or_warn 0     "${DATA_DIR}/certs"

# Lock down the TLS cert directory: only root (Caddy's uid) may enter it, and
# any cert/key files inside are 0600. Caddy runs as root with cap_drop:ALL, so
# it reads them as the OWNER; no other host user can read your private key.
if [ -d "${DATA_DIR}/certs" ]; then
  chmod 0700 "${DATA_DIR}/certs" 2>/dev/null || true
  find "${DATA_DIR}/certs" -type f -exec chmod 0600 {} + 2>/dev/null || true
fi

# Preflight: in custom TLS mode the named cert + key must be present before
# launch, or Caddy refuses to start. (acme/internal modes need no files here.)
TLS_MODE="$(read_env_var TLS_MODE acme)"
if [ "${TLS_MODE}" = "custom" ]; then
  cert="${DATA_DIR}/certs/$(read_env_var SSL_CERT_FILENAME origin.pem)"
  key="${DATA_DIR}/certs/$(read_env_var SSL_KEY_FILENAME origin.key)"
  if [ -f "${cert}" ] && [ -f "${key}" ]; then
    echo "  TLS_MODE=custom: found ${cert} and ${key}"
  else
    echo "  WARN: TLS_MODE=custom but your cert/key are not in place yet:" >&2
    [ -f "${cert}" ] || echo "          missing cert: ${cert}" >&2
    [ -f "${key}" ]  || echo "          missing key:  ${key}" >&2
    echo "        Put both files there and re-run this script before" >&2
    echo "        'docker compose up', or Caddy will fail to start." >&2
  fi
fi

# ── done ─────────────────────────────────────────────────────────────────────
echo ""
echo "Pre-deployment init complete (.env + secrets + storage at ${DATA_DIR})."
echo "Still TODO by hand in .env:  APP_HOST, APP_URL, AUTH_URL,"
echo "  BLIZZARD_CLIENT_ID/SECRET, WCL_CLIENT_ID/SECRET, and the SMTP_* values."
echo "Then start the stack:  docker compose up -d"
