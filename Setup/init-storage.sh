#!/usr/bin/env sh
# ---------------------------------------------------------------------------
# init-storage.sh — create the data directory tree with correct ownership
#
# The bundled containers run as non-root users. On Linux, a freshly created
# bind-mount directory is owned by root, so Prometheus, Loki, and Grafana
# cannot write to theirs and fail to start. Caddy is the mirror image: it runs
# as root but with cap_drop:ALL (no CAP_DAC_OVERRIDE), so it CANNOT write a
# store owned by anyone else — its dirs must be owned by uid 0. This script
# creates every data directory and sets the ownership each service needs. It
# also locks down the TLS cert dir (root-only, key 0600) and, when TLS_MODE=
# custom, warns if your certificate/key aren't in place yet.
#
#   sh ./init-storage.sh        (use sudo if chown is denied)
#
# Run it once after setting DATA_DIR in .env, and again whenever you change
# DATA_DIR. Re-running is safe.
# ---------------------------------------------------------------------------
set -eu

cd "$(dirname "$0")"

# read_env_var KEY DEFAULT — read KEY's value from .env, stripping an inline
# " # comment", surrounding quotes, and trailing whitespace. Falls back to
# DEFAULT when .env is missing or the line is blank.
read_env_var() {
  _key="$1"; _val="$2"
  if [ -f .env ]; then
    _v="$(grep -E "^${_key}=" .env | head -n1 | sed "s/^${_key}=//")"
    _v="$(printf '%s' "${_v}" | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" -e 's/[[:space:]]*$//')"
    [ -n "${_v}" ] && _val="${_v}"
  fi
  printf '%s' "${_val}"
}

DATA_DIR="$(read_env_var DATA_DIR ./data)"
echo "Using DATA_DIR=${DATA_DIR}"

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

# These container users need to own their data dir (uid:gid):
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

echo "Storage ready at ${DATA_DIR}"
