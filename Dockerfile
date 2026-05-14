# syntax=docker/dockerfile:1.7
# Multi-stage build for production. Run with docker-compose.prod.yml.

# ─── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat python3 make g++
COPY package.json package-lock.json ./
# --ignore-scripts skips the `postinstall: prisma generate` hook here
# (the schema isn't copied yet). The build stage runs prisma generate
# explicitly once the full source tree is in place.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund

# ─── build ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client into src/generated/prisma (matches schema output path).
RUN npx prisma generate

# SKIP_ENV_VALIDATION lets the build proceed without runtime secrets present.
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV SKIP_ENV_VALIDATION=1
RUN npm run build

# ─── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apk add --no-cache tini curl \
 && addgroup -g 10001 -S app \
 && adduser -S -D -H -u 10001 -G app app

# Copy only what the app needs to run.
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/package-lock.json ./package-lock.json
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/.next ./.next
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=app:app /app/next.config.ts ./next.config.ts
COPY --from=build --chown=app:app /app/src/generated ./src/generated

USER app

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
