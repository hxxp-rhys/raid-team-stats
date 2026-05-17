# Raid Team Stats — Companion Uploader

WoW addons can't talk to the internet, so this tiny script reads what the
**RaidTeamStatsUploader** addon saved and sends it to the website. It's the
piece that makes the **World / Delve Great Vault** row work (Blizzard has no
API for it).

## Requirements

- [Node.js 18+](https://nodejs.org) (no `npm install` needed — zero dependencies)
- The `RaidTeamStatsUploader` addon installed (see the addon's folder / the
  Account page download)

## Setup

1. Copy `config.example.json` to `config.json` (same folder) and fill in:
   - `token` — your upload token from the website **Account** page
   - `wowPath` — your WoW install folder (the one containing `_retail_`)
   - `api` — leave as `https://raiders.hxxp.io` unless self-hosting
2. In WoW: install the addon, log in, and `/reload` (or log out once) so the
   game writes the SavedVariables file.

## Run

```sh
# one-shot upload
node upload.mjs

# stay running and auto-upload as you play (re-checks every 5 min)
node upload.mjs --watch
```

Tip: put the `--watch` command in a `.bat`/shell script and run it at login
so it's always up to date. Each `/reload` or logout refreshes the snapshot;
the watcher uploads it automatically.

## What it sends

Only your own character's Great Vault (incl. World/Delve), this-week M+
runs, gear/enchants and talent loadout — read live from the game. Nothing
else. Auth is your personal upload token (rotate or revoke it any time on
the Account page).

## Troubleshooting

- **"No SavedVariables found"** — log in with the addon enabled, then
  `/reload`. WoW only writes the file on `/reload` or logout.
- **401 unauthorized** — token is wrong or was rotated; re-copy it.
- **404 character not found** — link/track that character on the site first
  (it must belong to your account).
