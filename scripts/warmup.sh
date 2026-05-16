#!/bin/sh
# Pre-warms Next.js dev routes so the first public hit isn't a 30-90s
# Turbopack JIT-compile (which causes Cloudflare to 524 before the page
# returns). Runs in the background after `next dev` boots; safe no-op if
# Next isn't ready yet — the readiness loop retries.

BASE="http://127.0.0.1:3000"

# Wait until /api/health returns 200. Cap at ~3 minutes so we don't loop
# forever if something is wrong.
i=0
while [ "$i" -lt 90 ]; do
  if wget -q -O /dev/null --timeout=2 "$BASE/api/health" 2>/dev/null; then
    break
  fi
  sleep 2
  i=$((i + 1))
done

# Warm the public-facing routes. These are the ones a fresh visitor hits
# first, plus the auth flow. Each curl triggers a Turbopack route compile
# so the next real request is served from the in-memory build cache.
# Errors (404s, redirects to /signin) don't matter — the compile happens
# either way. `--max-time 120` lets Turbopack finish cold compiles
# without us bailing too early.
# Static + auth pages.
for path in \
  "/" \
  "/signin" \
  "/signup" \
  "/verify" \
  "/reset/request" \
  "/account" \
  "/settings" \
  "/admin" \
  "/admin/users" \
  "/admin/guilds" \
  "/admin/audit" \
  "/admin/queues" \
  "/profile" \
  "/guild" \
  "/api/auth/providers"
do
  wget -q -O /dev/null --timeout=120 "$BASE$path" 2>/dev/null || true
done

# Dynamic route MODULES compile per route-file, not per-param — so hitting a
# placeholder id compiles the same module a real id would. This pre-warms the
# heavy guild-detail + team Control Panel + dashboard view/edit pages so the
# first real navigation isn't a 10-20s cold compile through Cloudflare.
PH="c0000000000000000000000000"
for path in \
  "/guild/$PH" \
  "/guild/$PH/team/$PH" \
  "/guild/$PH/team/$PH/dashboard" \
  "/guild/$PH/team/$PH/dashboard/$PH" \
  "/guild/$PH/team/$PH/dashboard/$PH/edit" \
  "/share/placeholder"
do
  wget -q -O /dev/null --timeout=120 "$BASE$path" 2>/dev/null || true
done

# The tRPC API route handler ('/api/trpc/[trpc]') compiles separately from the
# pages that call it — and that first compile is what made `/guild` hang ~9s.
# A minimal valid batch GET (input = {"0":{"json":null}}) compiles the handler;
# the auth/validation outcome doesn't matter, only that Turbopack builds it.
TRPC_INPUT="%7B%220%22%3A%7B%22json%22%3Anull%7D%7D"
for proc in \
  "guild.myGuilds" \
  "dashboard.list" \
  "raidTeam.get" \
  "snapshot.latestForTeam" \
  "admin.overview"
do
  wget -q -O /dev/null --timeout=120 \
    "$BASE/api/trpc/$proc?batch=1&input=$TRPC_INPUT" 2>/dev/null || true
done

echo "[warmup] done"
