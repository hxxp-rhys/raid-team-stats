# Lessons — bugs that cost real iteration

Each entry took multiple CI rounds (or hours of head-scratching) to
diagnose. Read this before doing anything tricky with prerender / CSP /
Prisma extensions / React hooks.

## CSP nonce + cacheComponents prerender

**Symptom:** `/signin` rendered empty in Playwright. Only the layout's
back-link visible. Form never appeared, even with a 15-second timeout.

**Diagnosis path (5+ CI iterations):**

1. First suspected stale build cache → wasn't.
2. Suspected lint pattern (`set-state-in-effect`) → fixed but didn't
   resolve the page.
3. Suspected `getByRole("heading")` against shadcn's `<div>` CardTitle →
   changed to `<h3>`. Other tests started passing. Signin stayed broken.
4. Switched to `input[type="password"]` selector → still empty.
5. Suspected Next 16's `useSearchParams` needing Suspense → wrapped it
   → still empty.
6. **Downloaded Playwright's error-context.md from the workflow artifact**
   and saw the page literally rendered only the layout. The Suspense
   fallback (`null`) was shipping to the browser and never resolving.

**Root cause:** Next 16 + `cacheComponents: true` serves `/signin` as a
fully-static prerender. The inner Suspense around `useSearchParams`
suspended at build time. There's no per-request server step in a
static-served route, so the suspension never resolves. The browser
receives the `null` fallback and the form never appears.

**Fix:** Don't use `useSearchParams` on statically-served pages. Read
`window.location.search` directly via a `useState` lazy initializer:

```tsx
const [callbackUrl] = useState<string>(() => {
  if (typeof window === "undefined") return "/profile";
  return new URLSearchParams(window.location.search).get("callbackUrl") ?? "/profile";
});
```

The server render falls through to the default; the client upgrades on
mount. No suspension, no fallback, no `react-hooks/set-state-in-effect`
lint violation.

**Related fix earlier in the same investigation:** the proxy must set
`Content-Security-Policy` on the *request* headers it forwards to Next,
not just on the response. Without it, Next's prerender emits unnonced
bundle `<script>` tags that `strict-dynamic` then refuses to execute.
This is independent of the Suspense issue but causes a similar "page is
empty" failure mode. See `src/proxy.ts`.

## Prisma 7 extended-client transaction types

**Symptom:** Helpers that took `Prisma.TransactionClient` typed cleanly
on their own but failed type-check when called with the `tx` argument
from `db.$transaction(async (tx) => {...})`.

**Root cause:** The `db` singleton is `client.$extends(...)` (the
encryption extension). The extended client's `$transaction` callback
parameter is NOT `Prisma.TransactionClient` — it's a wider, extension-
aware type.

**Fix:** Derive the type from the actual client:

```ts
type TxClient = Parameters<Parameters<typeof db.$transaction>[0]>[0];
```

Used in `src/server/guild-auth/lifecycle.ts` and anywhere else that
takes a transaction client. Don't use `Prisma.TransactionClient` for
helpers in this codebase.

## React 19 lint rules

`react-hooks/purity` and `react-hooks/set-state-in-effect` are both
**errors** (not warnings) in our config. Two patterns to know:

### Date.now() during render

```tsx
// ❌ react-hooks/purity error — Date.now() is impure
const now = Date.now();

// ✅ captured once at mount via useState lazy initializer
const [now] = useState(() => Date.now());
```

Used in `src/components/widgets/roster-freshness.tsx`.

### State derived from fetched data

```tsx
// ❌ react-hooks/set-state-in-effect — setState inside an effect
useEffect(() => {
  if (q.data) setLayout(parseLayout(q.data.layout));
}, [q.data]);

// ✅ set state during render via a "previously-seen" id
const [initFromId, setInitFromId] = useState<string | null>(null);
if (q.data && initFromId !== q.data.id) {
  setLayout(parseLayout(q.data.layout));
  setInitFromId(q.data.id);
}
```

Used in `src/app/(app)/guild/[guildId]/team/[teamId]/dashboard/
[dashboardId]/edit/page.tsx`.

## Next 16 + Tailwind 4 + `next build`

Set NODE_ENV=production at the GitHub Actions **step** level, not the
**job** level. `npm ci` skips devDependencies when NODE_ENV=production
is set, which means `@tailwindcss/postcss` (a devDep) goes missing and
Turbopack's build dies with `Cannot find module '@tailwindcss/postcss'`.

Both belt-and-braces fixes in place:

```yaml
# Job-level env deliberately omits NODE_ENV
- name: Install dependencies
  run: npm ci --no-audit --no-fund --include=dev  # explicit

- name: Start app
  run: npm run start ...
  env:
    NODE_ENV: production  # only here
```

## Container `node_modules` named volume

Adding a dep on the host (`npm install foo`) doesn't propagate to the
running web container. The container's `/app/node_modules` is a named
volume populated at image build, not refreshed on bind-mount changes.

```bash
docker compose exec web npm install --no-audit --no-fund
docker compose restart web
```

This bit us during shadcn's init (it added `tailwind-merge`,
`tw-animate-css`, `class-variance-authority`) — the host package.json
updated, but `/signin` in the container returned 500 because the new
deps weren't there.

## CardTitle wasn't a heading

shadcn's default `CardTitle` rendered as `<div>`, so
`getByRole("heading", {name: ...})` returned no match. Changed to `<h3>`
in `src/components/ui/card.tsx`. This is also a real a11y win: screen
readers now announce card titles as headings.

## Don't return raw secrets from tRPC

The WoW Audit and MFA flows store encrypted secrets. Read paths return
metadata + a hint (e.g. last-4 of the API key) — **never** the
plaintext. Mutations accept the secret as input but the procedures
encrypt before persisting and don't echo back. If a future feature
needs the plaintext (e.g. to display a secret for the user to verify),
add an explicit single-use flow rather than relaxing the read path.

## ROW_LOCK on guild claim — atomic conditional UPDATE wins

The plan called for `SELECT FOR UPDATE` + INSERT. The actual implementation
in `src/server/guild-auth/claim.ts` uses an atomic conditional
`UPDATE guild SET claimStatus='GM_CLAIMED' WHERE id=? AND claimStatus='UNCLAIMED'`
and checks the affected-row count. Same race-resolution guarantees,
fewer round-trips, no lock-contention concerns. Don't switch to
`SELECT FOR UPDATE` without measuring why.
