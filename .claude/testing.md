# Testing

Four layers, in increasing cost / setup. Aligned with `docs/testing.md`.

## Vitest (`npm test`)

Pure unit tests + light integration. Lives in `src/**/*.test.ts` and
`tests/**/*.test.ts`. Snapshot-stable; no external services required for
most tests.

The token-bucket suite uses a live Redis at `REDIS_URL` — set
`SKIP_REDIS_TESTS=1` to skip (CI does this; locally with
`docker compose up redis` the tests pick up the running container).

Test env defaults live in `tests/setup.ts`. **Don't add real secrets
there** — the file is committed.

## Playwright (`npm run test:e2e`)

Browser-driven smoke against a running app. `tests/e2e/smoke.spec.ts`
hits:

- `/` security header set (CSP / HSTS-ready / X-Frame-Options / etc.)
- `/signin` form renders (waits for `input[type="password"]`)
- `/signup` form renders
- `/profile` redirects to `/signin` when unauthenticated
- `/guild` renders without crashing (status < 500)
- `/api/health` returns JSON

Locators use form elements rather than headings to avoid brittle
selector matching against shadcn's primitives. See `lessons.md` for the
diagnostic history.

CI's `e2e` job boots Postgres + Redis services, builds the app, runs
`next start`, then `npm run test:e2e`. Failures upload the Playwright
HTML report + app stdout as workflow artifacts.

The Playwright spec lives outside of vitest's include glob — they don't
conflict.

## OWASP ZAP baseline (`.github/workflows/zap.yml`)

Manual trigger + Mondays 06:00 UTC. Boots the dev stack, runs
`zaproxy/action-baseline@v0.14.0` against `http://localhost:3000`,
uploads HTML/JSON report as artifact.

Tune false positives via `.zap/rules.tsv` — keep each suppression
documented inline with the rule ID.

## k6 (`tests/load/k6-auth.js`)

Hand-run only, not in CI. Smoke under sustained load with thresholds:
p95 < 300ms on `/api/health`, p95 < 800ms on `/signin`, < 1% failed
requests.

```bash
k6 run tests/load/k6-auth.js
k6 run --env BASE_URL=https://staging.example.com --vus 25 --duration 2m tests/load/k6-auth.js
```

If a threshold fails, suspect the rate-limit middleware sizing first,
then Postgres / Redis saturation.

## Notes for Claude

- **Don't add tests for behaviour the language enforces.** TypeScript
  strict catches most "did I forget a field" mistakes; tests are for
  business rules (cascade, authz, rate-limit math).
- **Prefer the hydration-tolerant selector.** Heading roles are
  intermittently flaky against shadcn's CardTitle (now `<h3>`, but
  test history shows assertions break across versions). Form elements
  via `[type="password"]` / `[type="email"]` are stable.
- **When CI fails on /signin specifically, suspect the CSP nonce + static
  prerender interaction.** See `lessons.md` — there's a known multi-iter
  diagnostic path for that.
- **The Battle.net + WoW Audit smokes are manual.** They depend on
  external auth round-trips and live API keys; documented in
  `docs/battlenet-smoke.md` and `docs/wowaudit.md`.
