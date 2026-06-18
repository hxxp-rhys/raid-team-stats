#!/usr/bin/env sh
# ---------------------------------------------------------------------------
# init-storage.sh — create the data directory tree with correct ownership
#
# The bundled containers run as non-root users. On Linux, a freshly created
# bind-mount directory is owned by root, so Prometheus, Loki, and Grafana
# cannot write to theirs and fail to start. This script creates every data
# directory and sets the ownership those three services need.
#
#   sh ./init-storage.sh        (use sudo if chown is denied)
#
# Run it once after setting DATA_DIR in .env, and again whenever you change
# DATA_DIR. Re-running is safe.
# ---------------------------------------------------------------------------
set -eu

cd "$(dirname "$0")"

# Read DATA_DIR from .env (default ./data). Strip an inline " # comment",
# surrounding quotes, and trailing whitespace so the path is clean.
DATA_DIR=./data
if [ -f .env ]; then
  v="$(grep -E '^DATA_DIR=' .env | head -n1 | sed 's/^DATA_DIR=//')"
  v="$(printf '%s' "${v}" | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" -e 's/[[:space:]]*$//')"
  [ -n "${v}" ] && DATA_DIR="${v}"
fi
echo "Using DATA_DIR=${DATA_DIR}"

mkdir -p \
  "${DATA_DIR}/postgres" \
  "${DATA_DIR}/redis" \
  "${DATA_DIR}/caddy" \
  "${DATA_DIR}/caddy-config" \
  "${DATA_DIR}/prometheus" \
  "${DATA_DIR}/loki" \
  "${DATA_DIR}/promtail-positions" \
  "${DATA_DIR}/grafana" \
  "${DATA_DIR}/backup-staging"

# These container users need to own their data dir (uid:gid):
#   Prometheus 65534 (nobody)   Loki 10001   Grafana 472
chown_or_warn() {
  uid="$1"
  dir="$2"
  if chown -R "${uid}:${uid}" "${dir}" 2>/dev/null; then
    echo "  set owner ${uid} -> ${dir}"
  else
    echo "  WARN: could not chown ${dir} to ${uid}. Re-run with sudo, or" >&2
    echo "        monitoring (Prometheus/Loki/Grafana) may fail to start." >&2
  fi
}

chown_or_warn 65534 "${DATA_DIR}/prometheus"
chown_or_warn 10001 "${DATA_DIR}/loki"
chown_or_warn 472   "${DATA_DIR}/grafana"

echo "Storage ready at ${DATA_DIR}"
