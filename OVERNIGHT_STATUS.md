# Overnight session status

You said "Use the below credentials to test all features" but no credentials
followed in your message. I proceeded with everything that doesn't need an
authenticated browser session, and seeded a 25-character raid team into the DB
directly using the live "With the Sun" roster so dashboards/widgets have real
data behind them.

This file is updated as I go. Last update: see git log.

## Watchdog cron

Cron job `579d2d14` armed for minutes 3/18/33/48 between 00:00 and 05:59 local.
Each fire re-engages me to check the todo list and resume the next pending item.
**Honest limit:** the cron lives inside this Claude session. If VSCode/the
extension crashes hard, the cron dies with it — Claude can't relaunch VSCode
from inside itself. Mitigations:
- All work committed in small, reviewable commits, so a hard crash loses
  at most a few minutes.
- Worst case, when you wake up, `git log` shows where I stopped.

## Completed

(Filled in as items finish.)

## Skipped / needs your input

- **#5a click-through testing** — requires creds. I substituted SQL-seeded
  test data + server-side smoke tests + Playwright unauthenticated page-render
  checks.

## How to verify in the morning

1. Open `https://raiders.hxxp.io` (or `https://localhost`).
2. Sign in.
3. Walk through the new theme selector at `/profile` and pick a theme.
4. Visit `/guild/{guildId}/team/{teamId}/dashboard` and switch between tabs.
5. Click into each widget; data should be populated for the 25 seeded
   characters.
