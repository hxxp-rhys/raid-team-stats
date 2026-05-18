#!/usr/bin/env bash
# cloudflare-firewall-sync.sh
#
# Keeps the host firewall so that ONLY Cloudflare can reach the public
# web ports (80/443). The site's Caddy runs as a Docker container, so
# Docker's own iptables DNAT *bypasses UFW entirely* — the only chain
# that actually filters container-published traffic is DOCKER-USER.
# This script therefore manages DOCKER-USER (v4 + v6) with an ipset of
# Cloudflare's published ranges, refreshed daily + at boot.
#
# Safety:
#   * Port 22 (SSH) is NEVER touched — only tcp dport 80/443.
#   * Cloudflare ranges are fetched + STRICTLY validated; on any fetch
#     or sanity failure the script exits WITHOUT changing the firewall
#     (fail-safe: keep the last known-good state, never wipe to empty).
#   * The ipset is built in a temp set and atomically `ipset swap`-ed,
#     so there is no window with a half-applied set.
#
# Install: /usr/local/sbin/cloudflare-firewall-sync.sh (root, 0750)
# Cron:    /etc/cron.d/cloudflare-firewall-sync  (04:00 daily + @reboot)
set -euo pipefail

LOG_TAG="cf-fw-sync"
log() { echo "[$(date -u +%FT%TZ)] $*"; logger -t "$LOG_TAG" -- "$*" || true; }
die() { log "ERROR: $*  (firewall left unchanged)"; exit 1; }

V4_URL="https://www.cloudflare.com/ips-v4"
V6_URL="https://www.cloudflare.com/ips-v6"
SET4="cf_v4"
SET6="cf_v6"
PORTS="80,443"
CMT="cf-fw-sync" # iptables comment tag for our rules

command -v ipset >/dev/null   || die "ipset not installed"
command -v iptables >/dev/null || die "iptables not installed"

fetch() { curl -fsS --max-time 15 --retry 3 --retry-delay 2 -- "$1"; }

# --- 1. fetch + validate BEFORE any mutation ------------------------------
RAW4="$(fetch "$V4_URL")" || die "failed to fetch $V4_URL"
RAW6="$(fetch "$V6_URL")" || die "failed to fetch $V6_URL"

mapfile -t V4 < <(printf '%s\n' "$RAW4" | tr -d '\r' | sed '/^$/d')
mapfile -t V6 < <(printf '%s\n' "$RAW6" | tr -d '\r' | sed '/^$/d')

v4re='^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$'
v6re='^[0-9A-Fa-f:]+/[0-9]{1,3}$'
for c in "${V4[@]}"; do [[ $c =~ $v4re ]] || die "bad v4 CIDR: '$c' (unexpected response)"; done
for c in "${V6[@]}"; do [[ $c =~ $v6re ]] || die "bad v6 CIDR: '$c' (unexpected response)"; done
# Sanity bounds: a truncated/HTML/empty response must never pass.
(( ${#V4[@]} >= 5  && ${#V4[@]} <= 200 )) || die "implausible v4 count ${#V4[@]}"
(( ${#V6[@]} >= 3  && ${#V6[@]} <= 200 )) || die "implausible v6 count ${#V6[@]}"
log "fetched Cloudflare ranges: ${#V4[@]} v4, ${#V6[@]} v6"

# --- 2. build ipsets in temp sets, swap atomically ------------------------
ipset create "$SET4" hash:net family inet  -exist
ipset create "$SET6" hash:net family inet6 -exist
ipset create "${SET4}_t" hash:net family inet  -exist
ipset create "${SET6}_t" hash:net family inet6 -exist
ipset flush "${SET4}_t"; ipset flush "${SET6}_t"
for c in "${V4[@]}"; do ipset add "${SET4}_t" "$c" -exist; done
for c in "${V6[@]}"; do ipset add "${SET6}_t" "$c" -exist; done
ipset swap "${SET4}_t" "$SET4"
ipset swap "${SET6}_t" "$SET6"
ipset destroy "${SET4}_t"; ipset destroy "${SET6}_t"

# --- 3. rebuild our DOCKER-USER rules deterministically -------------------
# DOCKER-USER is consulted (from FORWARD) BEFORE Docker's per-container
# ACCEPTs, so dropping non-Cloudflare 80/443 here filters the published
# Caddy ports while leaving every other container/flow alone (RETURN).
sync_chain() { # $1=iptables|ip6tables  $2=setname  $3=docker-src-cidr
  local ipt="$1" set="$2" dnet="$3"
  "$ipt" -L DOCKER-USER -n >/dev/null 2>&1 || {
    log "WARN: $ipt has no DOCKER-USER chain — ${ipt}/80,443 NOT filtered"
    return 0
  }
  "$ipt" -F DOCKER-USER
  "$ipt" -A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
  # CRITICAL: DOCKER-USER is in the FORWARD path and sees BOTH directions.
  # The 80/443 DROP below has no inbound-interface match, so without this
  # rule it also drops CONTAINER EGRESS to any :80/:443 (Blizzard / WCL /
  # Raider.IO), silently breaking every sync. Container traffic has an
  # RFC1918 (v4) / ULA (v6) source; genuine external inbound never does,
  # so allowing these sources cannot be used to bypass the CF-only filter.
  "$ipt" -A DOCKER-USER -s "$dnet" -p tcp -m multiport --dports "$PORTS" \
         -m comment --comment "$CMT" -j RETURN
  "$ipt" -A DOCKER-USER -p tcp -m multiport --dports "$PORTS" \
         -m set --match-set "$set" src -m comment --comment "$CMT" -j RETURN
  "$ipt" -A DOCKER-USER -p tcp -m multiport --dports "$PORTS" \
         -m comment --comment "$CMT" -j DROP
  "$ipt" -A DOCKER-USER -j RETURN
  log "$ipt DOCKER-USER synced (egress allowed; inbound 80/443 CF-only)"
}
sync_chain iptables  "$SET4" "172.16.0.0/12"
sync_chain ip6tables "$SET6" "fc00::/7"

log "done — only Cloudflare may reach tcp 80/443; SSH/22 untouched"
