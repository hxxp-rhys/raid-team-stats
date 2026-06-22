# Security Policy

## Reporting a vulnerability

Email the maintainer (do NOT open a public GitHub issue) and include:

- A description of the vulnerability and its impact.
- Steps to reproduce.
- Affected version / commit SHA.
- Suggested mitigation if known.

Coordinated disclosure preferred: please allow 14 days for a fix before public
disclosure.

## Security model

This project follows OWASP ASVS L1 as a baseline, with specific mitigations per
concern (CSP, CSRF, brute-force, SSRF, encryption-at-rest, etc.) enforced in the
application. See the **Security** and **Hardening your hosting environment**
sections of the [README](./README.md) for the operator-facing controls.

Authentication is implemented via Auth.js v5 with both a Credentials provider
(Argon2id password hashing) and Battle.net OAuth. Battle.net is a primary
identity: signing in with a linked Battle.net account authenticates as its
owner, and signing in with one that isn't linked to anyone auto-creates a new
(email-less) account and links it.

## Cryptography

- Passwords: Argon2id (m=64 MiB, t=3, p=1) via the `argon2` package.
- OAuth tokens (`Account.access_token`, `Account.refresh_token`, `Account.id_token`):
  AES-256-GCM column-level encryption on top of database-level encryption-at-rest.
  Master key is `TOKEN_ENCRYPTION_KEY` (env, 32 raw bytes base64-encoded). This
  key must remain stable: changing it makes every existing encrypted column
  unreadable. Rotating it therefore requires re-encrypting all encrypted values
  (decrypt with the old key, then re-encrypt with the new) — no automated
  rotation tool is shipped yet, so treat the key as long-lived and protect it
  accordingly.
- Audit-log IPs: SHA-256 with a daily-rotating salt; raw IPs never persisted.
- CSRF: Auth.js cookie SameSite=Lax + tRPC same-origin checks. Server Actions
  are POST-only with built-in origin validation.

## Known dependency advisories (accepted with mitigations)

These advisories affect transitive dependencies that we cannot upgrade without
introducing breaking changes (downgrading the framework itself). We document
each, the assessed risk in our context, and the mitigation that keeps the risk
acceptable. Revisit on every dependency review.

### 1. `nodemailer <= 8.0.4` — SMTP command injection (moderate)

- **Advisories:** GHSA-c7w3-x93f-qmm8, GHSA-vvjj-xcjg-gr5g.
- **Why we accept:** Pulled in transitively by `@auth/core`. No upstream fix in
  the Auth.js v5 beta channel at time of writing.
- **Mitigation in code:** We never expose `envelope.size` or transport `name`
  options to user input. All email sending paths use a single server-controlled
  transport configuration built from env vars; from/to/subject are constructed
  from validated user IDs or app-controlled templates.
- **Re-check:** when Auth.js v5 ships a stable release that pins a patched
  nodemailer.

### 2. `postcss < 8.5.10` — XSS via CSS stringify output (moderate)

- **Advisory:** GHSA-qx2v-qp2m-jg93.
- **Why we accept:** Pulled in transitively by `next`. The only `audit fix` is
  to downgrade Next.js several major versions — unacceptable regression.
- **Mitigation in code:** The vulnerability requires attacker-controlled CSS
  input. Our CSS comes from our own source files and Tailwind 4; no user input
  is processed through postcss.
- **Re-check:** when a Next.js patch release bumps postcss.

### 3. `@hono/node-server < 1.19.13` — middleware bypass via repeated slashes (moderate)

- **Advisory:** GHSA-92pp-h63x-v22m.
- **Why we accept:** Pulled in transitively by `@prisma/dev`, which we do not
  use (dev runs against a real Postgres, not Prisma's embedded dev server). The
  Prisma 7 CLI embeds `@prisma/dev` as a default optional path for users running
  `prisma dev`.
- **Mitigation:** Do not run `prisma dev`. Our dev workflow runs a real Postgres
  and applies migrations with `npm run db:migrate` (Prisma `migrate dev`), which
  does not load `@prisma/dev`.
- **Re-check:** when Prisma 7 patches the transitive dep, or if we adopt
  `prisma dev` for any workflow.

## Headers

Production headers are enforced both by the Next.js proxy (`src/proxy.ts`,
`src/server/security/headers.ts`) and by the Caddy reverse proxy
(`Caddyfile`). Belt-and-braces — neither layer alone is authoritative.

Verify with:

```bash
curl -I https://your-host/  | grep -iE '(content-security|strict-transport|x-frame|x-content-type|referrer|permissions)'
```

## Disclosure history

_(none yet — this is a new project)_
