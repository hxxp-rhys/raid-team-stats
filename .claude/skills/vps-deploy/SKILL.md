---
name: vps-deploy
description: Use this skill whenever you deploy code or a binary artifact to the production Linode VPS for raid-team-stats, restart the web/worker/Caddy containers, run a Prisma migration in prod, or debug "works on origin but 404/stale through Cloudflare". It is the authoritative runbook — the exact sequence, the order that matters, and the failure modes that have each cost real debugging time. If a step fails or you find a better way, update this file the same session.
---

# Deploying raid-team-stats to the VPS

## Topology

- Host: `root@66.228.39.54`. **SSH password is provided by the user
  in-session — never hardcode it in a committed file.**
- Tooling: PuTTY `plink.exe` / `pscp.exe` at
  `/c/Program Files/PuTTY/`, used with `-batch -pw "<pw>"`. The
  **PowerShell tool errors (exit 1, no output) in this env — use the
  Bash tool** to invoke `plink`/`pscp`/`powershell.exe`.
- Repo root on VPS is **`/root`** itself. Bind mount `/root → /app`
  (compose). Named volumes *shadow* the bind mount at
  `persistent_data/web/{node-modules,next-cache,prisma-client}` →
  `/app/{node_modules,.next,src/generated}`.
- Working branch is **`development`**. Standing rule: **never merge to
  `main` unless the user explicitly says so.**
- `docker-compose.yml`, containers `rts-web`, `rts-worker`, `caddy`.

## A. Sync source code (git bundle — NEVER WinSCP)

WinSCP corrupts `node_modules` (strips exec bits, partial copies,
missing `prisma_schema_build_bg.wasm`) and root-owns observability
dirs. Always use a git bundle:

1. **Get the VPS's ACTUAL current HEAD first** (bundle base must be a
   commit the VPS has, or `git fetch` fails):
   `plink … "cd /root && git rev-parse --abbrev-ref HEAD && git log --oneline -1"`
2. Commit locally on `development` (scoped `git add` of just the files;
   the working tree may hold unrelated in-flight work). End commit msgs
   with the `Co-Authored-By: Claude …` trailer.
3. `git bundle create <tmp>.bundle <vpsHEAD>..development`
4. `pscp` the bundle to `/root/<x>.bundle`.
5. On VPS: `cd /root && git fetch /root/<x>.bundle development && git merge --ff-only FETCH_HEAD && rm /root/<x>.bundle`
   (it fast-forwards because the VPS tree has no edits to tracked files).
6. Verify: `git log --oneline -1` matches, grep a changed line.

Source-only changes that aren't part of the Next build (installer
sources, `AGENTS.md`, skills, scripts) need **no web restart**.

## B. Ship a binary / gitignored artifact (e.g. the MSI)

`installer/dist/*.msi` is gitignored; the `/uploader/installer` route
reads it from disk **every request** (`process.cwd()` = `/app`,
`Cache-Control: no-store`). So just place the file:

1. `pscp local.msi root@…:/root/installer/dist/<name>.msi.new`
2. VPS: `mv -f …/<name>.msi.new …/<name>.msi && chmod 644 …` (atomic
   swap so a request never sees a half-written file).
3. Verify served bytes both ways:
   - origin: `curl -skI --resolve raiders.hxxp.io:443:127.0.0.1 https://raiders.hxxp.io/uploader/installer`
   - via CF: `curl -skI https://raiders.hxxp.io/uploader/installer`
   Both `content-length` must equal the new file size. No rebuild.

## C. Deploy a WEB CODE change (Turbopack does NOT watch the bind mount)

Order is mandatory:

```
docker compose stop web
rm -rf persistent_data/web/next-cache/*
docker compose up -d --force-recreate web      # NOT `up -d web` — won't recreate a running container
# wait for health: curl -sf localhost:3000/api/health (loop until 200)
docker compose restart caddy                   # MANDATORY after web recreate
# prewarm public routes (curl them) before declaring done
```

- Skipping `--force-recreate` → cache wiped under a live process →
  breaks it.
- Skipping the **Caddy restart** → Cloudflare↔origin serves stale /
  hung / 404 streamed HTML even though origin is fine.
- Do the same dance locally too (user runs the app in both places).

## D. Prisma migration in prod

`prisma migrate dev` is interactive-only (blocked non-interactively).
Author SQL with
`prisma migrate diff --from-config-datasource … --to-schema … --script`,
then `prisma migrate deploy`. **After any migration:** clear
`persistent_data/web/next-cache` (else *all* routes 404) and
`npx prisma generate` (stale client). Then do the §C web dance.

## E. Cloudflare (raiders.hxxp.io is proxied)

- **New `/api/*` paths 404 at the CF edge** (edge-cached pre-deploy
  404 / zone behavior). Mitigation used here: serve new endpoints under
  **`/uploader/*`**, not `/api/*`. After deploying a genuinely new
  path the **user must purge Cloudflare** — you cannot.
- DNS must point at `66.228.39.54`; SSL mode **Full (strict)**.
- Diagnosis: `--resolve raiders.hxxp.io:443:127.0.0.1` hits the origin
  with correct SNI; `--resolve …:66.228.39.54` tests the public IP
  bypassing CF; plain curl goes through CF. If origin is 200 but CF is
  404, it's a CF cache/DNS issue, not the app.

## F. Host typecheck gate

`rm -rf .next` **before** `npx tsc --noEmit` (stale generated
`validator.ts` otherwise). **Never run `next typegen` on the host** — it
breaks the validator. Ignore throwaway `^scripts/` diag-script lines.

## G. MSI installer build (Windows)

`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$env:DOTNET_ROOT='C:\Users\rhysf\.dotnet'; $env:PATH='C:\Users\rhysf\.dotnet\tools;C:\Users\rhysf\.dotnet;'+$env:PATH; & '<repo>\installer\build.ps1'"`

- WiX **v6** (`wix` global tool 6.0.0 + `WixToolset.UI.wixext/6.0.0`).
  v7 demands a paid OSMF EULA — avoid.
- **Bump `installer/Package.wxs` `Version=` every release** —
  `MajorUpgrade` only replaces an install when the version is *higher*.
  Also bump it to cleanly supersede a *partially-installed / rolled-back*
  prior attempt on the user's machine.
- MSI strings must be CP1252 (no `→`, `…`, box-drawing).
- **`installer/ca.js` runs under CLASSIC JScript (ES3 engine), not
  Node.** It rejects modern JS — most dangerously **trailing commas in
  function-call argument lists** (Prettier adds these to multi-line
  calls!), and also `let`/`const`/arrow/template-literals/`for…of`. ONE
  syntax error fails the WHOLE script → every custom action fails →
  "Setup Wizard ended prematurely … system has not been modified" (it
  aborts at `verifyInputs`, the first CA, before any file is written).
  Keep `sh.Run()` etc. single-line (build the command into a `var`
  first) so Prettier can't wrap+comma them. `build.ps1` step [3/5] now
  gates this with `cscript //NoLogo //E:JScript installer\ca.js` — the
  exact engine MSI uses; run it standalone to debug
  (`(line,col) … Syntax error`). This symptom = check ca.js FIRST.
- Then ship via §B (binary artifact — no web dance; the
  `/uploader/installer` route reads the MSI from disk per request).

## Related memory

`vps-sync-winscp-pitfalls`, `docker-next-cache-prisma`,
`cloudflare-stale-api-404`, `host-tsc-next-types` capture the same
hazards from the debugging sessions that produced this runbook.
