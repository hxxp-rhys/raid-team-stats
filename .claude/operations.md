# Operations

## Local development

```bash
# Boot Postgres + Redis + the Next.js dev server in containers
docker compose up -d
```

The web container takes ~2 min on first run (image build), then seconds
afterwards. The container's entrypoint runs `prisma generate` and
`prisma migrate deploy` before starting `next dev`.

Hit the running app at `http://localhost:3000`. Health probe at
`/api/health` (liveness) and `/api/ready` (DB + Redis).

## OneDrive caveat

The repo lives under a OneDrive-synced folder on Windows. OneDrive can
hold file locks on `node_modules/` and `.next/` during sync, manifesting
as ENOENT / EBUSY errors mid-build. If you see those:

1. Right-click the project folder → **Free up space** or pause OneDrive
   sync for the repo folder.
2. `rm -rf .next` and rebuild.

For native-host development (`npm run dev` on the host), this is mostly
fine because the named volumes `rts-node-modules` and `rts-next-cache`
shadow the bind-mount paths. Issues mainly hit when OneDrive tries to
sync `node_modules/` itself.

## Common gotchas

### After installing new npm deps on the host

The web container's `node_modules` is a named volume populated when the
image was built. Host `npm install` does not propagate. Refresh:

```bash
docker compose exec web npm install --no-audit --no-fund
docker compose restart web
```

### After modifying `prisma/schema.prisma`

```bash
docker compose exec web npx prisma migrate dev --name <descriptive_name>
```

The migration auto-applies and `prisma generate` runs as a postinstall
hook. The Next.js dev server picks up generated client changes through
the bind mount.

### Dev SMTP fallback

If `SMTP_HOST` is unset (or NODE_ENV !== production), `src/lib/email.ts`
swaps in a no-op transporter that logs the message payload via pino
instead of sending. Useful for testing the register → verify flow
without a real SMTP server.

To smoke a verify flow without any SMTP at all:

```bash
docker compose exec web npx tsx scripts/dev-issue-verify-token.ts \
  verify_email user@example.com
```

This mints a `VerificationToken` and prints the raw token + the full
verify URL to stdout. Refuses to run when `NODE_ENV === "production"`.

### Stale node.exe locking port 3000

If `npm run dev` was run on the host previously, a leftover `node.exe`
may hold port 3000 and shadow the container's port forward. Symptoms:
`/signin` returns a 500 page with Windows file paths in the error.
Find and kill:

```bash
tasklist | grep node.exe
taskkill /F /PID <pid>
```

## CI

GitHub Actions runs three workflows:

- **`ci.yml`** — on every PR + push to main. Two jobs:
  - `build`: lint, typecheck, vitest, build, npm audit
  - `e2e`: Playwright smoke against a `next start`-ed app + real
    Postgres + Redis services
- **`zap.yml`** — manual + Mondays 06:00 UTC. OWASP ZAP baseline scan
  against a `next start`-ed app. Tunable via `.zap/rules.tsv`.

Job-level `NODE_ENV` must NOT be set to `production` because that makes
`npm ci` skip devDependencies. The `--include=dev` flag is also passed
explicitly as belt-and-braces.

## Production deploy

`docker-compose.prod.yml` brings up Caddy (auto-TLS), Next web, BullMQ
worker, PgBouncer, Postgres, Redis. See `docs/production-deploy.md` for
the host setup checklist.

Daily encrypted Postgres backup: `scripts/backup.sh` runs `pg_dump | age
| rclone` with the recipient key set in `BACKUP_AGE_PUBKEY`. The private
key stays offline.

## Useful npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Native-host Next.js dev (use if Docker HMR feels slow) |
| `npm run build` | Production build (matches CI) |
| `npm run start` | Run production build (post-build) |
| `npm run lint` | ESLint flat config |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest one-shot |
| `npm run test:e2e` | Playwright smoke (needs `npm run test:e2e:install` once) |
| `npm run db:migrate` | Prisma `migrate dev` |
| `npm run db:studio` | Prisma Studio visual DB browser |
| `npm run db:reset` | Drop and re-create the dev DB |
