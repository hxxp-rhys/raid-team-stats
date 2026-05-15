# Overnight session status

You said "Use the below credentials to test all features" but no credentials
followed in your message. I proceeded with everything that doesn't need an
authenticated browser session, and seeded a 25-character raid team into the DB
directly using the live "With the Sun" roster so dashboards/widgets have real
data behind them.

## Watchdog cron

Cron job `579d2d14` armed for minutes 3/18/33/48 between 00:00 and 05:59
local. **Honest limit:** the cron lives inside this Claude session. If
VSCode/the extension crashes hard, the cron dies with it — Claude can't
relaunch VSCode from inside itself.

## What I completed

1. **Deep static-analysis review + fixes** (commit d10a5d6)
   - markUnobservedAbsences was silently skipping characters that vanished
     between syncs. Fixed.
   - trpc.ts allowedOrigins now lazy-built (would have crashed Docker
     image-build under SKIP_ENV_VALIDATION).
   - /api/metrics now reads METRICS_TOKEN through the env validator so a
     blank string doesn't accidentally enable token-mode.
   - raidTeam.eligibleCharacters had redundant filters; simplified.
2. **Route/link audit** — clean. One real bug fixed: `#mfa` anchor on
   /profile had no target. Now `<Card id="mfa">` on MfaCard.
3. **Raid-leader stat research** — docs/widget-research.md captures the
   reference spreadsheet column inventory + standard tool patterns
   (WoW Audit, raider.io, WCL).
4. **5 new widgets** (commit ef679b4-area)
   - class_composition (class + role bars, tank/heal/dps counts)
   - ilvl_distribution (histogram with min/median/mean/max)
   - missing_fixes (action list of missing enchants/gems by iLvL)
   - mplus_weekly (runs, highest, vault slots)
   - talent_loadouts (spec per character)
5. **Tabbed dashboards** — layout v2 shape, viewer + share + editor all
   updated, v1 layouts auto-migrate on read into a single "Overview" tab.
6. **25-character team seeded** — directly into the DB on the "Eclipse"
   raid team (ID `cmp69ejay00005eofu07nhv2t`), 25 highest-rank chars from
   "With the Sun". Tier A ran against them so equipment + iLvL snapshots
   exist for all 25.
7. **Starter dashboard** — "Eclipse — full demo" at slug `eclipse-demo`
   inserted with 4 tabs (Readiness / Progression / M+ / Composition)
   covering all 13 widget types.
8. **User-creation flow fixed**
   - `auth.resendVerification` endpoint + UI on /verify to recover when
     SMTP silently fails.
   - Password reset now sets `emailVerified` so unverified-but-credentialed
     accounts can unstick themselves via the reset flow.
   - Timing-equalised hashPassword on duplicate-email signup to close the
     enumeration oracle.
   - Rate-limit key falls back to a shared sentinel (not the submitted
     email) so rotating emails can't sidestep per-IP caps.
9. **Persistence verified** — all stateful services (postgres, redis,
   grafana, loki, prometheus, caddy ACME) mount named volumes. Redis runs
   with `--appendonly yes`. A `docker compose restart` preserves data.
10. **5 themes** (commit ef679b4)
    - default-dark, alliance (blue+gold), horde (crimson+iron), parchment
      (sepia/light-base), void (purple+neon-teal).
    - Server-rendered via `data-theme` attr from `rts-theme` cookie. No
      first-paint flash.
    - Profile page has a swatch picker; Server Action persists the cookie
      and revalidates the layout segment.
    - Smoke-tested all five against `https://localhost/` — each renders
      with the correct `data-theme` attribute on `<html>`.
11. **Final pass** — `tsc --noEmit` clean, `eslint .` has 3 cosmetic
    warnings (intentional underscore-prefixed unused args + the
    `signIn({ user, ... })` destructure that documents the shape).

## Skipped / needs your input

- **#5a click-through testing as you** — no credentials in the message.
  Substituted with SQL-seeded test data + Playwright-headless route
  smoke (every public route returns 200) + server-side smoke probes.
- **M+/raid/vault/WCL ingestion** — Tier-A originally only fetched
  summary + equipment. Extended during the overnight pass to also write:
  - **spec** (CharacterSnapshot.specName) → unblocks talent_loadouts
  - **raid encounters** → unblocks raid_completion
  - **M+ profile** (current rating + weekly highest + best runs) →
    unblocks mplus_ladder + mplus_weekly
  - Result: **11 of 13 widgets** render real data for the seeded team.
  - Still empty: vault_progress (derived, needs M+ slot + raid combo
    logic), wcl_parses (separate GraphQL pipeline).

## How to verify in the morning

1. Open `https://raiders.hxxp.io` (or `https://localhost`).
2. Sign in as `rhyscorgi@gmail.com`.
3. **Theme selector** is on `/profile` — pick anything, the whole site
   re-themes via SSR.
4. **Eclipse raid team** at `/guild/cmp68k01m000857qp7m37qsmq/team/cmp69ejay00005eofu07nhv2t`
   has 25 members.
5. **"Eclipse — full demo" dashboard** at the team's dashboard page —
   four tabs, click between them to see widgets switch.
6. **Resend-verification flow** — visit `/verify` with no `?token=` to
   see the new resend form. (Won't actually fire an email because your
   own account is already verified, but the form should render.)

## Where the commits landed

```
git log --oneline -8
```

…shows the overnight commits stacked on `main`. Read each commit message
for the per-change intent. Nothing pushed to remote — you can review
locally and `git push` when ready.
