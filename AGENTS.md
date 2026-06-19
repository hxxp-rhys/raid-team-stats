<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Skills: capture repeated work and all API knowledge

These rules are mandatory and apply to every session.

## Make a skill for any task repeated more than three times

The moment you are about to perform the same task for the **fourth** time
(it has already been done more than three times), stop and create a skill
for it first. Every skill MUST begin with a one-line description in the
form "Use this skill when …" that is specific enough for a future Claude
Code instance to recognize when it applies **without** reading the body.
Skills are living documents: if a skill produces a wrong result, fails, or
you discover a better way to do the task, update that skill in the same
session.

## One skill per external API

Every external API this project talks to has its own dedicated skill that
is the single source of truth for using it correctly — auth/token flow,
base URLs and regions, the exact endpoints/queries used here, rate limits
and budgets, pagination, response quirks, error/retry handling, and any
version/expansion drift notes. **One API source = one skill** (e.g.
`battlenet-api`, `warcraftlogs-api`, `raiderio-api`). Build the skill the
first time you integrate or debug that API; correct it whenever the live
API contradicts the skill.

# FROZEN wire contract — NEVER change without the owner's explicit approval

The **addon → companion → website** upload pipeline rests on a tiny, load-bearing
"wire contract." The companion app is **notify-only and lags behind** the addon
and website, so changing ANY of these elements **silently breaks data uploads
for every already-installed companion** — it stops finding or parsing the export
and quietly stops uploading, with **no error the user ever sees**, until each
user manually updates their companion.

These elements are **FROZEN**. Do NOT modify, rename, restructure, refactor, or
"clean up" any of them without the **project owner's explicit, in-conversation
approval**:

1. **The `RTS1:` export prefix AND the `export` key name** — the
   `["export"] = "RTS1:<base64>"` shape. Producer: `addon/StatSmith/StatSmith.lua`.
   Consumers: `companion/upload.mjs` + `companion/sea-entry.cjs` (`extractExport`
   regex) and the website ingest route's `RTS1:` decode
   (`src/app/uploader/ingest/route.ts`).
2. **The SavedVariables filename `StatSmith.lua`** (= the addon `.toc` basename;
   companion `findSavedVarFiles`). Renaming the addon folder/files changes this
   and orphans every installed companion + the user's saved data.
3. **The `complete` flag** that gates partial captures (addon writes it;
   companion `captureIsPartial`; website ingest re-checks it).

**MANDATE:** before proposing or making ANY change that would touch the above,
you MUST first STOP and display a VERY LARGE, UNMISSABLE warning as its own
prominent block — for example:

```
████████████████████████████████████████████████████████████████████████
█  ⚠  STOP — FROZEN WIRE-CONTRACT CHANGE — OWNER APPROVAL REQUIRED  ⚠   █
████████████████████████████████████████████████████████████████████████
This touches the addon <-> companion <-> website wire contract
(RTS1: export prefix / "export" key / StatSmith.lua filename / complete flag).
It will SILENTLY STOP DATA UPLOADS for every already-installed companion
(which is notify-only and lags behind) until each user MANUALLY updates it —
with no visible error to the user.

Requires: the owner's EXPLICIT approval, AND it must ship as a COUPLED
companion + addon release (new signed MSI) — NEVER an addon-only change.
████████████████████████████████████████████████████████████████████████
```

Then explain the impact in full and obtain explicit approval before proceeding.
A contract change ALWAYS ships as a coupled companion+addon release (new signed
MSI), never addon-alone (an auto-updated addon must never outrun the companion's
transport — the companion is the compatibility gatekeeper for addon updates).
