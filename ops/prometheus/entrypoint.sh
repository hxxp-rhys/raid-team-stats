#!/bin/sh
# Substitute METRICS_TOKEN into prometheus.yml at container start, then
# exec the upstream binary with the original flags. Keeping the token out
# of the committed config file means it's the same as any other env-driven
# secret in the stack.
set -e

if [ -z "$METRICS_TOKEN" ]; then
  echo "ERROR: METRICS_TOKEN must be set so Prometheus can scrape /api/metrics" >&2
  exit 1
fi

sed "s|METRICS_TOKEN_FROM_ENV|${METRICS_TOKEN}|g" \
  /etc/prometheus/prometheus.yml > /tmp/prometheus.yml

exec /bin/prometheus \
  --config.file=/tmp/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --web.enable-lifecycle \
  "$@"
