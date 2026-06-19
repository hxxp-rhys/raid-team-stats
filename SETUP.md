# Setup Guide — self-hosting Raid Team Stats

This guide gets a guild from zero to a running instance. The whole stack runs in
Docker, so you don't need to install Node, Postgres, or Redis yourself.

There are three pieces. Only the first is required:

| Piece | Required? | What it does |
|---|---|---|
| **Web service** (this repo) | ✅ Required | The dashboards, calendar, recruitment, and APIs. Runs in Docker. |
| **StatSmith addon** (`addon/StatSmith/`) | Optional | An in-game addon that reads data Blizzard's API doesn't expose (the World/Delve Great Vault row, tier sets, held keystones, weekly lockouts, professions, bag consumables). |
| **Companion uploader** (`companion/`) | Optional | A tiny script that sends what the addon saved to your instance. Needed only if you use the addon. |

> **Compliance note (please read once).** You must register **your own** API
> credentials with Blizzard, Warcraft Logs, and (optionally) Discord — never
> share keys. Run this as a **free, non-commercial** tool for your community.
> Blizzard's API terms forbid charging for features that use their data, and
> Warcraft Logs requires written approval for any commercial use. See the repo's
> discussion of this if you plan to do anything beyond free self-hosting.

---

## 1. Prerequisites

- **[Docker](https://docs.docker.com/get-docker/)** with Docker Compose (Docker
  Desktop on Windows/macOS, or Docker Engine on Linux).
- **[Git](https://git-scm.com/downloads)** to clone the repo.
- **`openssl`** to generate secrets (bundled with macOS/Linux and Git for Windows).
- For a *public* instance: a small VPS (Hetzner / DigitalOcean / Fly.io) and a
  **domain name** you control. For just trying it out, none of that is needed.

---

## 2. Get the code

```bash
git clone https://github.com/hxxp-rhys/raid-stats.git
cd raid-stats
cp .env.example .env
```

You'll edit `.env` in the next steps. The app validates every value at boot and
**refuses to start in production** if a required one is missing or malformed.

---

## 3. Register API credentials

This is the only fiddly part. Each provider gives you an ID + secret you paste
into `.env`. Take them one at a time.

### 3a. Blizzard Battle.net — **required** (login + most character data)

1. Go to <https://develop.battle.net/access/clients> and **Create Client**.
2. Register **both** redirect URIs — the app's built-in callback path (you can add more later):
   - `http://localhost:3000/api/auth/callback/battlenet` (local testing)
   - `https://your-domain.example/api/auth/callback/battlenet` (your real domain, when you have one)
3. Copy the Client ID and Secret into `.env`:
   ```
   BLIZZARD_CLIENT_ID=...
   BLIZZARD_CLIENT_SECRET=...
   BLIZZARD_REGION=us            # us | eu | kr | tw — match your guild's region
   ```

### 3b. Warcraft Logs — **required for parse & coaching widgets**

1. Go to <https://www.warcraftlogs.com/api/clients/> and create a client.
2. Set its redirect URI to `http://localhost:3000/wcl-callback` (and your prod
   URL later).
3. Fill in `.env`:
   ```
   WCL_CLIENT_ID=...
   WCL_CLIENT_SECRET=...
   WCL_HOURLY_POINTS_BUDGET=17000   # leave as-is; reserves headroom under the rate limit
   WCL_RAID_ZONE_ID=                # leave blank to auto-detect the current raid tier
   ```

### 3c. Raider.IO — **optional, no key needed**

The public Raider.IO endpoints (used for Mythic+ rating) need no key. Leave
`RAIDERIO_API_KEY` commented out. If a value is absent the app falls back to
Blizzard's Mythic+ data.

### 3d. Discord bot — **optional** (raid calendar → Discord posts)

Leave all three blank to disable Discord entirely; nothing else is affected.

1. Create an app at <https://discord.com/developers/applications>.
2. Copy: **General Information → Application ID** → `DISCORD_APP_ID`,
   **Public Key** → `DISCORD_PUBLIC_KEY`, **Bot → Reset Token** → `DISCORD_BOT_TOKEN`.
3. Set the **Interactions Endpoint URL** to `<APP_URL>/uploader/discord/interactions`.
4. Invite the bot with scopes `bot applications.commands` (it does **not** need Administrator).

### 3e. Email (SMTP) — **optional** (account verification, reminders)

For account-verification emails, password resets, and raid auto-reminders, point
`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` at any SMTP
provider. Without it, you can still verify accounts using the dev token script
(see Troubleshooting).

---

## 4. Generate the app secrets

Run these and paste each result into the matching `.env` key:

```bash
openssl rand -base64 48     # -> AUTH_SECRET           (session signing)
openssl rand -base64 48     # -> SHARE_TOKEN_SECRET    (signs dashboard share links — recommended)
openssl rand -base64 32     # -> TOKEN_ENCRYPTION_KEY  (encrypts stored OAuth tokens; must decode to 32 bytes)
openssl rand -hex 32        # -> METRICS_TOKEN         (REQUIRED in production)
```

`SHARE_TOKEN_SECRET` is optional: if you skip it, share links are signed with
`AUTH_SECRET` instead — which means revoking a leaked link would force everyone
to log in again. Setting a separate value lets you revoke **all** share links on
their own (by rotating just this key). `METRICS_TOKEN` is optional in local dev
but **required in production** — the app refuses to boot without it.

Also make yourself a platform admin so you can manage everything from the UI —
set this to the email you'll sign in with:

```
ADMIN_EMAILS=you@example.com
```

The database and cache defaults in `.env` already match the Docker Compose
services, so you don't need to touch `DATABASE_URL` or `REDIS_URL` for local use.

---

## 5. Run it (local)

```bash
docker compose up -d
```

The first boot builds the image (~2 minutes); after that it's seconds. The
container automatically runs `prisma generate` and `prisma migrate deploy`, so
the database schema is set up for you.

Open **<http://localhost:3000>**. Health checks live at `/api/health` and
`/api/ready`. View logs with `docker compose logs -f web`.

---

## 6. First run in the app

1. **Create your account** and verify the email (or use the dev token script below).
2. Because your email is in `ADMIN_EMAILS`, you're a **platform admin**.
3. **Link your Battle.net** account from the profile/account page.
4. **Verify your guild**, then create a **raid team** inside it.
5. **Build a dashboard** — add widgets from the palette, drag/resize to taste,
   and optionally share a read-only link.

---

## 7. (Optional) Install the addon for the addon-only data

Some widgets (World/Delve Great Vault, tier sets, held keystones, weekly
lockouts, professions, consumable readiness) need data **no Blizzard API
exposes**. The StatSmith addon + companion uploader fill that gap.

1. **Install the addon:** copy the `addon/StatSmith` folder into your WoW
   `…/World of Warcraft/_retail_/Interface/AddOns/` folder. Enable it on the
   character screen, log in, and `/reload` (WoW only writes the data file on
   `/reload` or logout).
2. **Get an upload token** from the **Account** page on your instance.
3. **Configure the companion:** copy `companion/config.example.json` to
   `companion/config.json` and set:
   - `token` — your upload token
   - `wowPath` — your WoW install folder (the one containing `_retail_`)
   - `api` — your instance URL (e.g. `https://your-domain.example`, or
     `http://localhost:3000` for local). It **must be `https://` in production**;
     the uploader refuses to send over plain HTTP.
4. **Run the uploader** (needs [Node.js 18+](https://nodejs.org), zero installs):
   ```bash
   node companion/upload.mjs --watch    # uploads now, then re-checks every 5 min
   ```

See [`companion/README.md`](./companion/README.md) for details.

---

## 8. Going to production (your own domain + HTTPS)

For production, use the self-contained deployment package in the
**[`Setup/`](./Setup/) folder**. It runs the **pre-built image** (no build step),
terminates **HTTPS** via Caddy (automatic Let's Encrypt by default, or bring your
own certificate — e.g. behind Cloudflare; see `Setup/README.md`), runs database
**migrations on boot**, bundles the **web app and the background sync worker**
from one image, and ships a **default-on monitoring stack** (Prometheus + Loki +
Grafana) you can opt out of.

You edit one file and run one command:

```bash
cd Setup
cp .env.example .env && ./generate-secrets.sh    # configure (one file)
./init-storage.sh                                # prepare storage
docker compose up -d                             # launch
```

The complete walkthrough — DNS records, production OAuth redirect URIs, the
monitoring opt-out, backups, and updates — is in
**[`Setup/README.md`](./Setup/README.md)**. That folder is the authoritative
production path; the rest of this page (steps 1–7) covers local development.

---

## 9. Updating

```bash
# local development (builds from source):
git pull
docker compose up -d --build

# production (from the Setup/ folder — pulls the new image, no build):
cd Setup && docker compose pull && docker compose up -d
```

Database migrations run automatically on container start, so a routine update is
just a pull + recreate (local dev rebuilds the image first).

### One-time steps for the PII-encryption release

This release encrypts all non-email PII (display names, avatars, recruitment
answers) at rest and rotates the companion upload token automatically. When you
upgrade an **existing** deployment to it, do these once (a brand-new install on
an empty database needs neither):

1. **Encrypt rows that predate encryption.** *After* the new version has been
   deployed (Step 9 above, so the running app can read what the backfill writes),
   run the idempotent backfill once:
   ```bash
   # from the Setup/ folder, against the running production stack:
   docker compose run --rm -e RUN_MIGRATIONS=false \
     web node_modules/.bin/tsx scripts/backfill-pii-encryption.ts
   ```
   (Or set `RUN_PII_BACKFILL=true` on the `web` service for a single deploy — the
   entrypoint runs it right after migrations — then remove it.) It's safe to
   re-run; already-encrypted rows are skipped. `TOKEN_ENCRYPTION_KEY` must be set
   and stable.

2. **Publish the companion installer — now via GitHub Releases, no per-server
   hosting.** CI builds the MSI on a Windows runner and attaches it to the
   project's GitHub Release; the app's `/uploader/installer` route just redirects
   to `…/releases/latest/download/raid-team-stats-uploader.msi`, so every
   instance shares one central download (nobody hosts the ~28 MB binary). To cut
   a release, bump `installer/Package.wxs` `Version=` and push a matching tag:
   ```bash
   git tag v1.0.21 && git push origin v1.0.21   # triggers installer-release.yml
   ```
   The repo must be **public** for anonymous downloads. The installer is
   instance-agnostic: each user enters their own site address + upload token at
   setup, so the one binary works for every deployment. (To build locally
   instead: `pwsh installer/build.ps1`.) To ship a **signed** installer (no
   Windows SmartScreen "unknown publisher" warning), configure Azure Artifact
   Signing — see [`installer/SIGNING.md`](installer/SIGNING.md). Companions that
   aren't updated keep working unchanged; they just don't rotate their token
   until upgraded.

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| App won't start in production, logs mention a missing env var | A required value in `.env` is blank/malformed. The error names the key. |
| Battle.net or WCL login fails with `redirect_uri` / `invalid_grant` / `400 callback URL is not valid` | The redirect URI in the provider console must match **exactly** — scheme, host, **and** path. Battle.net = `/api/auth/callback/battlenet`; WCL = `/wcl-callback`. Register both the localhost and the production URLs. |
| Addon-only widgets are blank (vault World row, tier, professions…) | Install the StatSmith addon **and** run the companion uploader (Step 7). `/reload` in-game after enabling the addon. |
| Can't receive the verification email | Configure SMTP, **or** mint a token locally: `docker compose exec web npx tsx scripts/dev-issue-verify-token.ts verify_email you@example.com` |
| First `docker compose up` is slow | Normal — the initial image build is ~2 minutes; later boots are seconds. |
| Mythic+ rating looks off | Raider.IO is optional; without it the app uses Blizzard's M+ data, which can lag a fresh run. |

---

## 11. Customizing &amp; rebranding (optional)

Rebrand the site and tailor the landing page **without editing code or
rebuilding the image** — every setting is an optional **server** environment
variable, read at runtime. Set any of them in your `.env` (root `.env` for local
dev, or `Setup/.env` for production); unset values fall back to sensible defaults.

| Variable | What it changes |
|---|---|
| `APP_NAME` | Site/product name everywhere (header, page titles, emails, MFA issuer). |
| `APP_TAGLINE` | Short tagline under the logo. |
| `APP_DESCRIPTION` | `<meta name="description">` for search engines + social cards. |
| `BRAND_LOGO_URL` | Logo in the header + on the homepage. |
| `HOMEPAGE_HEADLINE` | Landing-page hero headline. |
| `HOMEPAGE_SUBHEADING` | Landing-page hero paragraph. |
| `HOMEPAGE_FOOTER_NOTE` | Small note in the landing-page footer. |

**Using your own logo.** Put your image where the web container can read it and
point `BRAND_LOGO_URL` at it. The cleanest way (without editing the shipped
compose file) is a small `Setup/docker-compose.override.yml` — Docker Compose
merges it automatically — that bind-mounts a folder into the container's
`public/` directory:

```yaml
services:
  web:
    volumes:
      - ./branding:/app/public/branding:ro
```

then in `Setup/.env` set `BRAND_LOGO_URL=/branding/logo.png` and drop `logo.png`
into `Setup/branding/`. (A square PNG ~128×128 looks best.) Per-user theme colors
are separately customizable from **Settings → Theme**.

**What can't be removed.** The subtle **About** and **Security** footer links,
the project credit, and the GitHub Sponsors link on the About page are a fixed
part of the open-source project's attribution and are intentionally not
configurable. Everything in the table above is yours to change.

---

## Getting help & supporting the project

- Open an issue on the GitHub repository for setup problems or bugs.
- If you find it useful, you can support hosting/development via the **Sponsor**
  button on the repo. (The tool itself is free, and the in-game addon always
  will be — donations support development, never gate features.)
