# Stack

Pinned versions (see `package.json` for exact ranges):

| Layer | Choice | Notable behaviour |
|---|---|---|
| Framework | **Next.js 16.2.6** (App Router) | Turbopack-only by default; `cacheComponents: true` opted in; `proxy.ts` replaces `middleware.ts` |
| React | 19.2.x | Server Components + Suspense are load-bearing; lint rules `react-hooks/purity` + `react-hooks/set-state-in-effect` are strict |
| Auth | **Auth.js v5 beta** (`next-auth@5.0.0-beta.31`) | JWT session strategy (not DB) because Credentials provider doesn't support DB sessions cleanly. Revocation via Redis JTI set. |
| API | tRPC v11 | Per-request context loads `auth()` session + IP + UA. Same-origin enforcement on mutations. |
| ORM | **Prisma 7.8** with `@prisma/adapter-pg` | Configured via `prisma.config.ts`, NOT inline `url = env(...)` (Prisma 7 removed that). Client output goes to `src/generated/prisma/`. |
| DB | PostgreSQL 16 | One migration per logical phase; cascade rules carefully chosen (see schema). |
| Cache / Queue | Redis 7 + BullMQ | Two ioredis singletons: `redis` (default) and `redisBlocking` (workers, `maxRetriesPerRequest: null`) |
| Crypto | `argon2` (passwords) + Node native `crypto` (AES-256-GCM for OAuth/MFA secrets) | Token cipher: `version | iv | tag | ciphertext`, base64 envelope. KEK from `TOKEN_ENCRYPTION_KEY` env (32 bytes base64-encoded). |
| Styling | Tailwind 4 + shadcn/ui (base-ui preset) | CSS-first config; `cn()` helper from `tailwind-merge` |
| Logging | pino (+ pino-pretty in dev) | Redaction list covers password / token / secret / authorization / cookie |
| Testing | Vitest + Playwright + k6 + OWASP ZAP | See `.claude/testing.md` |
| Container | Node 22 Alpine | Non-root runtime user, `tini` PID 1, healthcheck via curl |

## Next 16 things that bit us

- **`middleware.ts` is `proxy.ts`** at project root (or `src/proxy.ts` with
  src-dir). The export is `function proxy()`.
- **`cacheComponents: true`** flips fetch caching to opt-in (`'use cache'`).
  Route segment configs (`export const dynamic = ...`, `export const
  runtime = ...`) are **incompatible**. Use `await connection()` to force
  dynamic instead.
- **`useSearchParams()`** on a fully-static prerendered page suspends at
  build time and never unblocks at request time. See `.claude/lessons.md`
  for the diagnostic story — use `window.location.search` via a
  `useState` lazy initializer instead.
- **CSP nonce + cacheComponents**: the proxy must set `Content-Security-
  Policy` on both the response AND the request headers it forwards into
  Next. Without the request-side CSP, Next's prerender emits unnonced
  bundle `<script>` tags and `strict-dynamic` refuses to execute them.
- **`typedRoutes: true`** at top level (moved out of `experimental` in 16).
- **`allowedDevOrigins`** required for cross-origin dev requests
  (Docker container binding 0.0.0.0 + Playwright hitting localhost).

## Prisma 7 things that bit us

- **`prisma.config.ts`** holds the datasource URL (no more `env("...")` in
  schema). `npx prisma migrate dev` and the runtime client both read it.
- **Driver adapter pattern**: `new PrismaClient({ adapter: new PrismaPg({
  connectionString: env.DATABASE_URL }) })`. There is no implicit
  connection string parsing.
- **Client extension types**: `Prisma.TransactionClient` does NOT carry
  the extended-client narrowing. For helpers that take `tx`, derive the
  type from the extended client itself:
  `type TxClient = Parameters<Parameters<typeof db.$transaction>[0]>[0]`.
- The encryption extension lives in `src/lib/db.ts`. It transparently
  encrypts/decrypts `Account.{access_token, refresh_token, id_token}` on
  every relevant model operation, idempotently (uses `isEncrypted()` to
  avoid double-encrypting).
- **`Prisma.InputJsonValue`** types reject bigints. The
  `snapshots.ts:toJsonValue()` helper coerces via `JSON.stringify` with a
  bigint→string replacer.
