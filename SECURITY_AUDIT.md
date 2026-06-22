# Security & Encryption Audit — raid-team-stats

**Date:** 2026-06-16
**Type:** Static source + configuration audit (read-only; no code or config was modified).
**Auditor scope:** entire repository — application + worker code, Dockerfiles/compose, Caddy config, CI/CD, Prisma schema + migrations, scripts, and git history.
**Method:** four parallel evidence-gathering passes (crypto/secrets, authN/Z, injection/leakage, infra/transport/CI/history); highest-impact findings independently re-verified against `file:line`.

> **Revised 2026-06-22.** The former root Compose files were consolidated into the single `Setup/docker-compose.yml`; file references below now point there. Several findings have since been fixed and are marked ✅ RESOLVED inline.

> **Stack-context correction.** The provided brief described an *"Azure-hosted, VMSS-based"* platform. That is **incorrect for this repo.** This is a **single-host Docker Compose** stack — Next.js 16 web + a BullMQ worker (both one image) behind **Caddy** (auto-TLS) and **Cloudflare**, with **PostgreSQL 16**, **Redis 7**, and **PgBouncer** as data-tier containers on a private bridge network, deployed to a single self-hosted server. No Azure, VMSS, autoscaling, or Kubernetes exists in the repo. Evidence: `Setup/docker-compose.yml`.

---

## Executive summary

**Overall posture: strong.** This is a security-conscious codebase. Passwords use **Argon2id**, OAuth/refresh tokens and the MFA secret are **field-encrypted with AES-256-GCM** (random IV, stored auth tag) on top of database storage, all reset/verify/upload tokens are **CSPRNG-generated and stored hashed with expiry**, the CSP is **strict nonce-based** (no `unsafe-inline`), object-level authorization is **consistently enforced** (no IDOR found), the public web container is **hardened** (non-root, read-only rootfs, all caps dropped, `no-new-privileges`), the data tier is **not published to any host interface**, backups are **age-encrypted and streamed** (no plaintext on disk), and **no secret has ever been committed to git history**.

**No Critical or High findings.** Since the 2026-06-16 audit, several findings have been fixed (see ✅ RESOLVED markers inline): **Redis now requires a password** (F1), **`METRICS_TOKEN` is now required in prod** (F4), the **logger now redacts email/avatarUrl/upload+share/OAuth tokens** (F7), the **data tier is now partially hardened** (`cap_drop`/`no-new-privileges` on postgres+redis — F6), **share tokens now use a dedicated `SHARE_TOKEN_SECRET`** (F2), and **recruitment applicant PII is now AES-256-GCM field-encrypted** (F11). The remaining meaningful risks are **defense-in-depth gaps** and **infrastructure controls that cannot be confirmed from the repository:**

1. **At-rest disk encryption** (Postgres volume, Redis AOF, the "mounted data disks", backup staging) **cannot be verified from code** — it is host/cloud configuration. The brief states real users' personal data is handled, so this must be confirmed manually; it is the single largest unknown.
2. A handful of smaller items: CI third-party actions are pinned to floating tags, the companion upload token never expires, app↔DB traffic does not enforce TLS, and pgbouncer/backup still lack the full data-tier hardening the web container has.

The most valuable next actions are now mostly operational/config: **confirm disk encryption and pin CI actions.**

---

## Sensitive-data & encryption findings (priority section)

Data is grouped by element. "At rest", "In transit", and "Keys/logs" state the verified protection and what's missing.

### User passwords
- **At rest:** **Argon2id**, 64 MiB / t=3 / p=1, per-hash salt (PHC string). `src/server/crypto/kdf.ts:13-18`. Verified via `argon2.verify` (constant-time), `needsRehash` upgrade path. **No** fast/unsalted/reversible hashing anywhere. ✅
- **In transit:** only over TLS (Caddy/Cloudflare); credentials POSTed to `/api/auth`. ✅
- **Logs:** `password`/`passwordHash` are redacted (`src/lib/logger.ts:5-6,27-28`). ✅

### OAuth tokens (Battle.net / WCL / Discord access, refresh, id) + MFA TOTP secret
- **At rest:** **AES-256-GCM, application-level field encryption** before DB storage — random 12-byte IV per message, 16-byte auth tag stored, versioned envelope. `src/server/crypto/token-cipher.ts:21-65`; key is a 32-byte `TOKEN_ENCRYPTION_KEY`, length-enforced, `src/server/crypto/key-source.ts:18-34`. Applied transparently via a Prisma client extension (`src/lib/db.ts:16-122`); the MFA TOTP secret uses the same cipher (`src/server/auth/mfa.ts:47`). ✅ Best-in-class for this dataset.
- **In transit:** TLS to the providers; stored encrypted. ✅
- **Keys:** `TOKEN_ENCRYPTION_KEY` required + validated, no fallback (`src/env.ts:60-65`). Rotation envelope exists (`CIPHER_VERSION`) but **no rotation script** is present — see Gaps.

### Session tokens
- **At rest/in transit:** JWT strategy (`src/server/auth/index.ts:44`), signed with `AUTH_SECRET`; 7-day maxAge, hourly refresh; **instant revocation** via a Redis `jti` blocklist (`:326-329,360-363`). Cookies rely on Auth.js v5 defaults (`httpOnly`, `sameSite=lax`, `secure`/`__Secure-` in prod) — no insecure override found (confirm live `Set-Cookie`, see Gaps). ✅

### Email-verify / password-reset / companion-upload tokens
- **At rest:** 256-bit `randomBytes(32)`, stored as a **SHA-256 hash** (`src/server/auth/tokens.ts:24,44-51`; `src/server/auth/upload-token.ts:19-24`), constant-time compared. Expiry: verify 24 h, reset 1 h. ✅ Upload token has **no expiry** — see **F8**.

### Dashboard share token (capability URL)
- **At rest:** stateless; not stored. HMAC-SHA256 over the payload, timing-safe verify, TTL embedded (≤30 d). `src/server/security/share-token.ts:53,105-126`. Scope re-pinned server-side to the token's `raidTeamId` (`dashboard.ts:255`); private dashboards still require login even with a valid token. ✅
- **Caveat:** key is `AUTH_SECRET` (**F2**); token sits **in the URL path** → can leak via access logs / browser history (mitigated by `Referrer-Policy: strict-origin-when-cross-origin` + expiry) — see **F12**.

### Service/API tokens (Blizzard & WCL client-credentials access tokens) + BullMQ job payloads
- **At rest:** **plaintext in Redis**, and **persisted to disk** via AOF + RDB. `src/server/ingestion/blizzard/client.ts:173`, `src/server/ingestion/warcraftlogs/client.ts:224`; persistence `Setup/docker-compose.yml`. Redis is **unauthenticated** (no `requirepass`) and **unencrypted** (`redis://`). This is **F1 (Medium)**.

### Applicant recruitment data (answers, applicantLabel, salted ipHash)
- **At rest:** stored as a JSON column **with no application-level encryption** — relies entirely on (unverified) database/disk encryption. Field-by-field whitelisted on write (no mass assignment), readable only by form officers. `src/server/api/routers/recruitment.ts`. Because forms can collect arbitrary PII, see **F11** + Gaps.

### Application secrets (AUTH_SECRET, TOKEN_ENCRYPTION_KEY, provider client secrets, SMTP_PASSWORD, POSTGRES_PASSWORD, METRICS_TOKEN)
- **At rest:** plaintext in `.env` / `.env.prod` **files on the host** (no managed secret store / no cloud KMS / no Docker secrets). Standard for a single-server deployment, but worth noting. **Never committed** — git-history scan is clean (see F-history). `.env`/`.env.*` are git-ignored and `.dockerignore`-excluded, so they are not baked into image layers (`.dockerignore:25-27`). ✅ for source hygiene; ⚠️ no secret-store / rotation tooling.

### Backups
- **At rest + in transit:** **age public-key encrypted**, streamed `pg_dump → age → rclone` (HTTPS) with **no intermediate plaintext file**. `Setup/scripts/backup.sh`. ✅ Excellent.

---

## Findings (ordered by severity)

### Medium

#### F1 — Redis is unauthenticated + unencrypted and persists service API tokens to disk
✅ **RESOLVED (2026-06-22):** `Setup/docker-compose.yml` runs redis with `--requirepass ${REDIS_PASSWORD}` and `REDIS_URL` embeds the password.
- **Category:** Crypto-in-transit / at-rest, infra.
- **Location:** `Setup/docker-compose.yml` (`REDIS_URL: redis://redis:6379`, `--appendonly yes --save 60 1000`, no `--requirepass`); token caching `src/server/ingestion/blizzard/client.ts:173`, `src/server/ingestion/warcraftlogs/client.ts:224`.
- **Risk:** Redis has no password and no TLS. It holds BullMQ job payloads (guild/character/team identifiers + job metadata) and the app's **Blizzard/WCL client-credentials access tokens** in plaintext, and AOF/RDB **write those to the `rts-redisdata-prod` volume unencrypted**. Any process that reaches `:6379` on the bridge — a second container, a future second host, or an accidental `ports:` publish — gets full read/write of the queues and the cached service tokens (letting an attacker burn the app's API quota or impersonate it to Blizzard/WCL). Currently mitigated **only** by the port being unpublished.
- **Remediation:** set `--requirepass ${REDIS_PASSWORD}` and switch `REDIS_URL` to include the password (and `rediss://` if you terminate TLS); at minimum add the password. Consider not persisting token-cache keys (or a very short TTL), and ensure the Redis data volume sits on an encrypted filesystem. **This would be Critical if `6379` were ever exposed.**

#### F2 — Share-token HMAC key is the session secret; no per-link revocation
✅ **RESOLVED (2026-06-22):** a dedicated `SHARE_TOKEN_SECRET` now exists (`src/env.ts:37`) with `AUTH_SECRET` fallback.
- **Category:** Crypto / key management.
- **Location:** `src/server/security/share-token.ts:16,53` (`createHmac("sha256", env.AUTH_SECRET)`).
- **Risk:** Share links are signed with `AUTH_SECRET`. Revoking a single leaked link requires rotating `AUTH_SECRET`, which **invalidates every active session** (forced global logout). Coupling the two keys also widens blast radius. There is no single-link kill switch (only per-dashboard `shareIsPublic` and expiry).
- **Remediation:** sign share tokens with a dedicated `SHARE_TOKEN_SECRET` (decouples rotation from sessions); optionally embed a per-link id checked against a small revocation set so one link can be killed without affecting others or sessions.

#### F3 — CI third-party actions pinned to floating tags / a moving branch
- **Category:** Supply chain / CI.
- **Location:** all workflows use floating major tags (`actions/checkout@v4`, `docker/*-action@v3/5/6`, `zaproxy/action-baseline@v0.13.0`); worst: `aquasecurity/trivy-action@master` at `security.yml:38`, `trivy.yml:29,67`.
- **Risk:** tags/branches are mutable. A compromised or retagged action executes in CI; `docker-publish.yml` runs on `push:main` with `packages: write` and the Docker Hub token, so a malicious action there could publish a poisoned image or exfiltrate `GITHUB_TOKEN`/`DOCKERHUB_TOKEN`.
- **Remediation:** pin every third-party action to a full commit SHA (Trivy especially — never `@master`); let Dependabot bump them. First-party `actions/*` are lower risk but ideally SHA-pinned too.

### Low

#### F4 — `METRICS_TOKEN` not enforced in production
✅ **RESOLVED (2026-06-22):** now `requiredInProd` (`src/env.ts:156`).
- **Category:** Secrets / config. **Location:** `src/env.ts:149-152` (`z.string().optional()`); comment says prod "should always set this."
- **Risk:** if unset in prod, `/api/metrics` falls back to admin-session-only; a misconfiguration could broaden access to internal metrics. (The endpoint returns 404 to unauthenticated callers, limiting discovery — `src/app/api/metrics/route.ts:30-39`.)
- **Remediation:** make it `requiredInProd(...)`, or fail closed when empty in production.

#### F5 — Database connections do not enforce TLS (`sslmode`)
- **Category:** Crypto-in-transit. **Location:** `Setup/docker-compose.yml` (`postgresql://...@pgbouncer:6432/...` — no `sslmode`).
- **Risk:** app↔pgbouncer↔postgres traffic is plaintext. Contained to the Docker bridge today (acceptable), but becomes a real exposure if the DB is ever split to another host. PgBouncer→Postgres auth is `scram-sha-256` (`:144`), which is good.
- **Remediation:** if the DB stays single-host, document the trusted-boundary assumption; if it may ever move, add `sslmode=verify-full` + a CA and enable TLS on Postgres/PgBouncer.

#### F6 — Data-tier containers are not hardened like the web container
⚠️ **PARTIALLY RESOLVED (2026-06-22):** postgres + redis now have `cap_drop: ALL` + `no-new-privileges` in `Setup/docker-compose.yml`; pgbouncer has `no-new-privileges` but still no `cap_drop`; the backup service is profile-gated.
- **Category:** Container config. **Location:** `Setup/docker-compose.yml` — `postgres`, `pgbouncer`, `redis`, `backup`, and `worker` lack `cap_drop: ALL`/`no-new-privileges`/`read_only` (web has all of them: `:48,52,55`).
- **Risk:** a compromise of one of these containers has more capabilities for lateral movement / escape than necessary.
- **Remediation:** add `cap_drop: ALL`, `security_opt: [no-new-privileges:true]` to the data-tier services (and `read_only` + a writable tmpfs/volume where the engine allows). `backup` additionally runs as **root and `apk add`s at runtime** — bake a fixed image and drop privileges.

#### F7 — Logger redact list omits `email` / `avatarUrl` (and token field-names)
✅ **RESOLVED (2026-06-22):** `src/lib/logger.ts` now redacts `email`, `*.email`, `avatarUrl`, `uploadToken`, `shareToken`, and access/refresh/id_token.
- **Category:** Leakage. **Location:** `src/lib/logger.ts:4-40` — `email`, `*.email`, `avatarUrl`, `uploadToken`, `shareToken` are **not** in `redactPaths`.
- **Risk:** no current call site logs a full `user` object (no `console.*` in `src/`; tRPC middleware logs only `path/type/duration/code`), so nothing leaks today — but a future `logger.info({ user })` or `{ uploadToken }` would emit PII/secrets in cleartext.
- **Remediation:** add `email`, `*.email`, `avatarUrl`, `uploadToken`, `shareToken`, `*.uploadToken`, `*.shareToken` to `redactPaths`.

#### F8 — Companion upload token never expires; rotation not forced
- **Category:** Token hygiene. **Location:** `src/server/auth/upload-token.ts` (no `expiresAt`/last-used).
- **Risk:** a leaked addon bearer token is valid until the user manually regenerates it. (Storage is fine — SHA-256 hashed.)
- **Remediation:** add an expiry / last-rotated timestamp and surface staleness, or support multiple named tokens with individual revocation.

#### F9 — Metrics token compared with `===` (not timing-safe)
- **Category:** Crypto misuse (minor). **Location:** `src/app/api/metrics/route.ts:30`.
- **Risk:** theoretical timing side-channel on the metrics bearer token; negligible given the 404-on-failure behavior and the endpoint being unpublished in prod.
- **Remediation:** compare with `crypto.timingSafeEqual` for consistency.

#### F10 — `isEnvAdmin` is an MFA-skipping admin check (currently unused)
- **Category:** AuthZ (latent). **Location:** `src/server/api/trpc.ts:171` — *defined only; no callers in `src/` (verified by grep).*
- **Risk:** unlike the async `isPlatformAdmin` (which **requires MFA**, `:201-205`), `isEnvAdmin` grants admin from `ADMIN_USER_IDS` alone with no MFA gate. It is not on any authorization path today, but its existence invites future misuse.
- **Remediation:** remove it, or rename/comment it clearly as non-authorization and add a lint/grep guard so it never gates access.

#### F11 — Applicant PII stored without field-level encryption; IP-hash retention
✅ **RESOLVED (2026-06-22):** recruitment `formSubmission`/`formAnswer` are now AES-256-GCM field-encrypted via the `db.ts` cipher extension (numeric `valueNumber` kept plaintext for sorting).
- **Category:** At-rest / privacy. **Location:** `src/server/api/routers/recruitment.ts` (answers JSON, `applicantUserId`, salted `ipHash`).
- **Risk:** recruitment forms can collect arbitrary PII (names, contact info, etc.). It is whitelisted and access-controlled, but at rest it relies **solely** on disk encryption (unverified — see Gaps). The salted `ipHash` is retained without an obvious consent/retention surface.
- **Remediation:** confirm disk encryption is on (required for this data); consider field-level encryption for free-text applicant answers if forms collect special-category data; ensure the privacy notice covers IP-hash retention and define a retention/erasure policy.

#### F12 — Share token travels in the URL path
- **Category:** Leakage. **Location:** `/share/<token>` route; token defined in `src/server/security/share-token.ts`.
- **Risk:** capability tokens in URLs can be captured by reverse-proxy/access logs, browser history, and analytics. `Referrer-Policy: strict-origin-when-cross-origin` (security headers) prevents cross-origin Referer leakage, and tokens expire (≤30 d), but the exposure in logs/history remains.
- **Remediation:** acceptable given the threat model; if tightening, prefer a short opaque slug that maps to a server-side record you can revoke, and scrub the token from access logs.

#### F13 — Addon payload nested arrays uncapped / `.passthrough()`
- **Category:** Resource limits. **Location:** `src/server/ingestion/addon/payload.ts:212,227` (`members`, `guildOnline` have no `.max()`, objects use `.passthrough()`).
- **Risk:** within one upload an attacker (with a valid token + owned character) can pack a large array, persisted verbatim as a JSON column. **Bounded by the 512 KB body cap** (`src/app/uploader/ingest/route.ts:91`) — storage bloat, not an amplification/DoS.
- **Remediation:** add `.max(...)` to `members`/`guildOnline`/`sessions` and drop `.passthrough()` on the persisted objects.

#### F14 — Grafana defaults to `admin`/`admin` (dev only)
✅ **RESOLVED (2026-06-22):** `Setup/docker-compose.yml` grafana uses `GF_SECURITY_ADMIN_PASSWORD` (default `change-me-before-exposing`, filled by `generate-secrets.sh`) and is loopback-only.
- **Category:** Default credentials. **Location:** `Setup/docker-compose.yml`; `.env.example:104-105`.
- **Risk:** real default creds — but heavily mitigated: Grafana binds to `127.0.0.1:3001` in dev, anonymous/signup are disabled, and **it does not exist in the prod compose at all**.
- **Remediation:** set a strong `GRAFANA_ADMIN_PASSWORD` in `.env` and never expose `:3001` beyond loopback.

### Info / verified-good (no action)
- **No SQL injection.** Only two `$queryRaw` usages, both parameterized tagged templates; `Prisma.join` for the IN-list (`src/server/api/routers/snapshot.ts:3044`); no `*Unsafe` anywhere; no string-built SQL in scripts/migrations.
- **No command injection / SSRF.** No `child_process` in app code; every outbound client uses a fixed base URL (Blizzard/WCL/RaiderIO/Discord); Discord IDs are snowflake-validated (`/^\d{15,22}$/`) before path interpolation.
- **Strict CSP.** Nonce-based `script-src`/`style-src`, no `unsafe-inline`, `unsafe-eval` dev-only; nonce set on request **and** response (`src/server/security/csp.ts`, `src/proxy.ts:62-67`). The two `dangerouslySetInnerHTML` uses (theme bootstrap, `src/app/layout.tsx:79,93`) interpolate only server-validated, `JSON.stringify`-quoted values.
- **No IDOR / broken object-level authorization / mass assignment / admin bypass** found — every id-accepting tRPC procedure gates via `assertRaidTeamRole`/`assertTeamReadAccess`/`requireFormOfficer` first; admin requires MFA (`trpc.ts:201-205`); public share + public recruitment paths are correctly scoped and PII-safe.
- **Rate limiting** (Redis sliding-window) on requests; per-token ingest limits; per-IP recruitment submit limit (5/hr).
- **Error handling:** tRPC default shape scrubs `INTERNAL_SERVER_ERROR` and omits stack traces when `NODE_ENV=production`; `poweredByHeader:false`.
- **Edge security headers:** HSTS (2 y, preload), full header set, dotfile blocking (`Setup/Caddyfile`); HTTP→HTTPS redirect.
- **Network posture (prod):** only Caddy publishes ports (80/443); **postgres/redis/pgbouncer/worker/web/backup publish nothing** → data tier unreachable off-host. Dev binds all data/observability ports to `127.0.0.1`.
- **CI:** least-privilege `permissions` on every workflow; **no `pull_request_target`** (forked PRs can't touch secrets); the only CI "secrets" are explicit non-production placeholders.
- **Git history: clean** — full `git log -p --all` scan for private keys, AWS/Slack/Discord tokens, `client_secret`/`AUTH_SECRET`/`TOKEN_ENCRYPTION_KEY` values, and the WCL client id found **only** placeholders/CI-noop values; no real `.env`/`*.pem`/`*.key` was ever committed.

---

## Quick wins (high impact / low effort)

**Done since 2026-06-16** (✅): Redis now has `--requirepass` (F1); `METRICS_TOKEN` is `requiredInProd` (F4); the logger redacts email/avatarUrl/upload+share/OAuth tokens (F7); postgres+redis got `cap_drop: ALL` + `no-new-privileges` (F6, partial); share tokens use `SHARE_TOKEN_SECRET` (F2); recruitment applicant PII is AES-256-GCM field-encrypted (F11).

**Still outstanding:**

1. **Pin `aquasecurity/trivy-action` (and other third-party actions) to a commit SHA** — removes the `@master` supply-chain risk. *(CI)*
2. **Finish data-tier hardening** — add `cap_drop: ALL` to pgbouncer (it already has `no-new-privileges`) and harden the (profile-gated) backup service. *(config)*
3. **Set a non-default `GRAFANA_ADMIN_PASSWORD`** (replace the `change-me-before-exposing` default) and confirm `:3001` is loopback-only. *(config)*

---

## Assumptions & gaps — verify manually (not determinable from the repo)

These are the controls the audit **could not confirm from code/config**; several are load-bearing for "real users' personal data":

1. **Disk / volume encryption at rest** — the single biggest unknown. Postgres data volume (`rts-pgdata-prod`), the **Redis AOF/RDB volume** (which holds service tokens — F1), the backup staging volume, and the brief's "mounted data disks" are all **host/cloud configuration**. `.env.example:31` *claims* DB disk encryption exists, but nothing in the repo proves it. **Confirm LUKS/cloud-disk encryption on every volume that persists data.**
2. **Host/cloud firewall** — the compose correctly publishes only 80/443, but a manual `docker run -p`, a host iptables rule, or a cloud security-group could differ. **Confirm only 80/443 are reachable on the server, and 6379/5432/6432 are not.**
3. **Cloudflare origin settings** — whether TLS mode is **Full (strict)** (the companion docs claim it), WAF/rate rules, "Always Use HTTPS", and origin-cert validity. The app trusts `X-Forwarded-Proto`/origin headers from the proxy chain — verify Cloudflare/Caddy set them correctly and that the origin can't be reached directly bypassing Cloudflare.
4. **Live cookie attributes** — confirm the production `Set-Cookie` for the session shows `__Secure-`/`__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax` (depends on Auth.js v5 defaults + `NODE_ENV=production` at runtime).
5. **`NODE_ENV=production` at runtime** — this is the only thing preventing tRPC from returning stack traces (F-info error handling) and ensuring secure cookies. Confirm the running containers have it (deploy docs indicate yes).
6. **Real secret values** — strength/uniqueness of `AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `METRICS_TOKEN`, Grafana creds (all live in `.env.prod`, correctly never committed). Confirm they are strong, unique, and not the `.env.example` placeholders.
7. **Key-rotation procedure** — `CIPHER_VERSION` supports rotation, but **no rotation script exists** in `scripts/`. Document/automate rotation for `TOKEN_ENCRYPTION_KEY` and `AUTH_SECRET`.
8. **Secret storage** — secrets live in plaintext `.env.prod` on the host (no KMS/managed secrets/Docker secrets). Acceptable for a single server, but consider Docker secrets or a managed store and ensure the file is `chmod 600`, root-owned, and excluded from backups.
9. **`SKIP_ENV_VALIDATION` is never set on running containers** (build-only) — confirm it is not present in `.env.prod` or the runtime environment.
10. **Dependency CVEs** — `npm audit`/Trivy run in CI but are **non-enforcing** (`continue-on-error`, `exit-code: 0`); a HIGH/CRITICAL CVE or a Trivy-detected secret will not block a merge. Review their latest output and consider gating `main`.

---

*End of audit. All findings cite concrete evidence; where a control could not be confirmed from the repository it is listed under Assumptions & gaps rather than assumed present or broken. No application code or configuration was modified.*
