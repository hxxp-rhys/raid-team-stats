#!/bin/sh
# ---------------------------------------------------------------------------
# caddy-entrypoint.sh — choose how Caddy gets its TLS certificate, then start.
#
# The Caddyfile imports /config/tls.caddy inside its site block. This script
# WRITES that snippet from the TLS_MODE env var before launching Caddy, so the
# same Caddyfile works for every TLS strategy with no file edits:
#
#   TLS_MODE=acme      Automatic HTTPS via Let's Encrypt (the default). Needs a
#                      public DNS record pointing here and ports 80/443 reachable
#                      from the internet. Do NOT use this behind a proxy that
#                      terminates TLS (e.g. Cloudflare orange-cloud) — the ACME
#                      challenge can't be validated. Set ACME_EMAIL for renewal
#                      notices (recommended).
#   TLS_MODE=custom    Use your OWN certificate + key. Put both files in the
#                      certs dir mounted at /certs and name them with
#                      SSL_CERT_FILENAME / SSL_KEY_FILENAME. The cert must be the
#                      FULL CHAIN (leaf + any intermediates). This is the mode
#                      for a Cloudflare Origin cert or any commercial/LE cert you
#                      obtained elsewhere.
#   TLS_MODE=internal  Caddy's own self-signed cert (local testing, or behind a
#                      proxy/load-balancer that does its own TLS and does not
#                      validate the origin cert).
#
# /config is a writable, root-owned volume, so writing the snippet there never
# trips over Caddy's cap_drop:ALL (no CAP_DAC_OVERRIDE) in the hardened composes.
# ---------------------------------------------------------------------------
set -eu

TLS_MODE="${TLS_MODE:-acme}"
SNIPPET="/config/tls.caddy"

case "${TLS_MODE}" in
  custom)
    cert="/certs/${SSL_CERT_FILENAME:-origin.pem}"
    key="/certs/${SSL_KEY_FILENAME:-origin.key}"
    if [ ! -r "${cert}" ] || [ ! -r "${key}" ]; then
      echo "caddy-entrypoint: FATAL — TLS_MODE=custom but cert/key not readable:" >&2
      echo "    cert: ${cert}" >&2
      echo "    key:  ${key}" >&2
      echo "  Put both files in the certs dir mounted at /certs, set" >&2
      echo "  SSL_CERT_FILENAME / SSL_KEY_FILENAME in .env, and make them" >&2
      echo "  readable by root (key mode 0600, owned by uid 0). The Setup" >&2
      echo "  package's ./init-storage.sh does this for you." >&2
      exit 1
    fi
    printf 'tls %s %s\n' "${cert}" "${key}" > "${SNIPPET}"
    echo "caddy-entrypoint: TLS_MODE=custom -> tls ${cert} ${key}"
    ;;
  internal)
    printf 'tls internal\n' > "${SNIPPET}"
    echo "caddy-entrypoint: TLS_MODE=internal -> Caddy self-signed certificate"
    ;;
  acme)
    if [ -n "${ACME_EMAIL:-}" ]; then
      printf 'tls %s\n' "${ACME_EMAIL}" > "${SNIPPET}"
      echo "caddy-entrypoint: TLS_MODE=acme -> Let's Encrypt (contact ${ACME_EMAIL})"
    else
      : > "${SNIPPET}"
      echo "caddy-entrypoint: TLS_MODE=acme -> Let's Encrypt (no ACME_EMAIL set)"
    fi
    ;;
  *)
    echo "caddy-entrypoint: FATAL — invalid TLS_MODE='${TLS_MODE}' (use: acme | custom | internal)" >&2
    exit 1
    ;;
esac

# Fall back to the image's default command if Compose didn't pass one.
if [ "$#" -eq 0 ]; then
  set -- caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
fi
exec "$@"
