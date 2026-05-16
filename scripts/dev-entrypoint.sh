#!/bin/sh
# Container entrypoint for the dev `web` service. Runs synchronous setup
# (bootstrap deps if missing, regenerate Prisma client, apply pending
# migrations), then launches the Next.js dev server in the foreground
# while a background warmer pre-compiles public routes so the first hit
# from Cloudflare doesn't 524 on a cold Turbopack JIT.

set -e

if [ ! -f /app/node_modules/.package-lock.json ]; then
  echo "[entrypoint] bootstrapping node_modules (first run)..."
  npm ci --no-audit --no-fund
fi

echo "[entrypoint] generating Prisma client..."
npx prisma generate

echo "[entrypoint] applying migrations..."
npx prisma migrate deploy

echo "[entrypoint] starting warmup in background..."
sh /app/scripts/warmup.sh &

echo "[entrypoint] launching next dev..."
exec npm run dev -- -H 0.0.0.0 -p 3000
