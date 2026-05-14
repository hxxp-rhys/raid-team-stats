# Testing

Three layers, in increasing cost/setup.

## Unit + integration (Vitest)

```bash
npm test               # one-shot
npm run test:watch     # watch mode
npm run test:coverage  # with v8 coverage
```

The `SKIP_REDIS_TESTS=1` env flag skips the token-bucket suite (which
needs a live Redis). CI sets this; local runs against `docker compose up
redis` pick the tests up automatically.

## End-to-end (Playwright)

```bash
npm run test:e2e:install   # one-time: download Chromium
npm run test:e2e
```

Tests live in `tests/e2e/`. The default smoke suite hits public surface
(home, signin, signup, health) and verifies the security-header set. It
does NOT require a primed DB.

To run against a different deploy:

```bash
PLAYWRIGHT_BASE_URL=https://staging.example.com npm run test:e2e
```

A separate suite that exercises register → verify → sign-in → /profile
needs a primed DB, a working SMTP transport (or the dev-token helper from
`scripts/dev-issue-verify-token.ts`), and is gated behind `RUN_AUTH_E2E=1`
because it mutates real DB state. **Don't run it against production.**

## OWASP ZAP baseline

CI workflow `.github/workflows/security.yml` runs `zaproxy/action-baseline`
weekly + on every push to `main`. Findings land as a workflow-run
artifact (`zap-report`) and can be downloaded from the Actions tab.

To run locally:

```bash
docker compose up -d
docker run --rm \
  -v "$(pwd)":/zap/wrk:rw \
  --network host \
  zaproxy/zap-stable zap-baseline.py \
    -t http://localhost:3000 \
    -r report.html
```

Tune false positives in `.zap/rules.tsv` (commit that file to keep the
suppression explicit and auditable).

## Load (k6)

```bash
# Install k6: https://k6.io/docs/get-started/installation/
k6 run tests/load/k6-auth.js
```

Scenario knobs:

```bash
k6 run --env BASE_URL=https://staging.example.com \
       --vus 25 --duration 2m \
       tests/load/k6-auth.js
```

The script asserts p95 latencies on `/api/health` and `/signin` and a
1 % error-rate ceiling on every request. A failed threshold is a
regression — either the rate-limit middleware is mis-sized for the
expected load or a dependency (Postgres, Redis) is saturating.

## Battle.net + WoW Audit (manual)

These flows depend on external IdPs/APIs and can't be reliably
automated in CI. Smoke-test checklist before each deploy:

- [ ] Battle.net OAuth: visit `/profile`, click **Link Battle.net**,
      complete the OAuth round-trip on `develop.battle.net`'s test
      account. Confirm redirect to `BATTLENET_REDIRECT_URI` and that the
      profile page reflects "Linked".
- [ ] Discover guilds: click **Discover guilds from Battle.net**.
      Confirm the response observes ≥1 character and matches a guild
      (or creates one if new). `/guild` should now list the discovered
      guild.
- [ ] Tier C manual sync: from `/guild/<id>`, click **Refresh roster
      from Battle.net**. Confirm a job ID is returned and that a
      `SyncRun` row appears in the DB (or the worker logs).
- [ ] WoW Audit: from the guild settings card, paste the team API key
      and click **Test connection**. Connection should succeed against
      the configured `wowauditBaseUrl` (default `https://wowaudit.com/v1`).
      A failed connection should not corrupt stored config.

## Security-test matrix (manual quarterly review)

Document in `SECURITY.md`. The minimum-viable set:

| Test | What it proves |
|---|---|
| XSS via dashboard names | React escapes default; widget config is JSON-only |
| CSRF on tRPC mutations | `Origin` header check + Auth.js SameSite=Lax cookie |
| SSRF via external clients | Outbound `fetch` constrained to allow-listed hosts |
| Authz matrix | non-member 404 on `/guild/X`; member-but-DEPARTED 404 |
| Brute force | 10 rapid `/api/auth/callback/credentials` POSTs from one IP throttled |
| MFA replay | recovery code is single-use; same code rejected twice |
| Account delete cascade | DB rows for the deleted user disappear; audit rows stay (actor=null) |
