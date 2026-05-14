# `.claude/` — project context

Drop-in context pack for new Claude sessions (or human teammates) working on
this repo. Read in order:

1. [`overview.md`](./overview.md) — what this app is and who it serves
2. [`architecture.md`](./architecture.md) — data model, sync tiers, RBAC
3. [`stack.md`](./stack.md) — Next 16 / Prisma 7 / Auth.js v5 / tRPC / BullMQ
   versions and version-specific behaviour
4. [`security.md`](./security.md) — token encryption, MFA, GDPR delete, CSP,
   accepted dependency advisories
5. [`operations.md`](./operations.md) — Docker dev stack, common gotchas, dev
   utility scripts
6. [`testing.md`](./testing.md) — vitest / Playwright / ZAP / k6 layers and
   how they interact with the CI workflow
7. [`integrations.md`](./integrations.md) — Blizzard, Warcraft Logs,
   Raider.IO, WoW Audit
8. [`phase-history.md`](./phase-history.md) — what's shipped, what's
   deferred, what's blocked on external input
9. [`lessons.md`](./lessons.md) — concrete bugs that cost real iteration
   time. **Read this before doing anything tricky with prerender / CSP /
   useSearchParams / Prisma extensions.**

The authoritative project plan lives outside the repo at
`~/.claude/plans/synchronous-inventing-candle.md` — that file is the
original 6-phase architecture document. Files here cover what changed
during execution + post-plan v1.1 work.

Anything not in this folder should be discoverable from the code. These
files exist for *non-obvious* context — the why, the constraints, and
the diagnostic stories.
