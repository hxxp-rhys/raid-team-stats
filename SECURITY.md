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
(Argon2id password hashing) and Battle.net OAuth. Email/password is the primary
identity; Battle.net is **link-only**. Signing in with a Battle.net account that
is already linked authenticates as its owner; signing in while already logged in
links Battle.net to the current account; signing in with an unlinked Battle.net
account is refused (you must register with an email first, then link). Battle.net
never auto-creates accounts — it exposes no email.

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

These advisories affect dependencies we cannot currently move to the patched
version without a breaking change (a peer-range conflict or a framework
downgrade). We document each, the assessed risk in our context, and the
mitigation that keeps the risk acceptable. Revisit on every dependency review.

### 1. `nodemailer < 8.0.3` — SMTP command injection (moderate)

- **Advisories:** GHSA-c7w3-x93f-qmm8 (`envelope.size`), GHSA-vvjj-xcjg-gr5g
  (transport `name`). Fixed upstream in nodemailer 8.0.4.
- **Why we accept:** nodemailer is a direct dependency pinned to the 7.x line
  because `@auth/core` (Auth.js v5 beta) declares a `^7.0.7` peer range; adopting
  the 8.0.4 fix requires an `@auth/core`/Auth.js upgrade that allows nodemailer 8.x.
- **Mitigation in code:** We never expose `envelope.size` or the transport `name`
  option to user input. All email sending paths use a single server-controlled
  transport configuration built from env vars; from/to/subject are constructed
  from validated user IDs or app-controlled templates.
- **Re-check:** when `@auth/core`/Auth.js v5 stable allows nodemailer ≥ 8.0.4.

### 2. `@hono/node-server < 1.19.13` — middleware bypass via repeated slashes (moderate)

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
(`Setup/Caddyfile`). Belt-and-braces — neither layer alone is authoritative.

Verify with:

```bash
curl -I https://your-host/  | grep -iE '(content-security|strict-transport|x-frame|x-content-type|referrer|permissions)'
```

## Disclosure history

_(none yet — this is a new project)_
