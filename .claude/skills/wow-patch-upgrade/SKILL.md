---
name: wow-patch-upgrade
description: Use this skill whenever WoW ships a new patch, raid tier, M+/PvP season, or expansion AND you must update this project's expansion-coupled references (WCL zone id, journal-instance ids, item-level cap/bands, addon TOC Interface version, profession-expansion name, enchant slots, etc.) — OR whenever you ADD a new current-expansion reference to the code. It is the single source of truth for every patch/tier/season/expansion-coupled value: where each one lives (file + durable constant name), where the new value comes from (the authoritative source + exact lookup procedure), and which updates are coupled so you never ship half of one. HARD RULE: if you add, move, or remove any current-expansion reference in the codebase, update this skill in the SAME session.
---

# WoW patch / expansion upgrade

This project hard-codes a small, deliberate set of values that track the
**current** WoW patch/tier/season/expansion. Everything else (encounter ids,
M+ season, vault thresholds, talents, tier-set detection, dungeon pools) is
resolved **dynamically** from Blizzard / WCL / the addon and needs no
maintenance. This skill is the map of the hard-coded set and the procedure to
roll each one forward.

> ## HARD RULE — keep this skill current
> The moment you **add, move, rename, or delete** any value that is specific to
> the current expansion/patch/tier/season (a zone id, a journal-instance id, an
> ilvl band, an ability-id allowlist, an expansion-name string, an enchant-slot
> set, a "bump each patch" comment, …), you MUST update the register below in
> the **same session**. A reference that exists in code but not here is a broken
> patch upgrade waiting to happen. This mirrors the AGENTS.md mandate that
> skills are living documents.

---

## Current game state (update this block every patch)

- **Expansion:** WoW **Midnight** (`12.x`)
- **Live patch:** **12.0.5** → addon Interface `120005` (12.0.7 "Sporefall" imminent — verify on release)
- **Season:** Season 1
- **Raid tier:** The Voidspire / March on Quel'Danas / The Dreamrift
- **WCL combined tier zone id:** **46** (`WCL_RAID_ZONE_ID`)
- **Journal-instance ids:** Voidspire `1307`, March on Quel'Danas `1308`, The Dreamrift `1314`
- **Item-level Myth ceiling:** **298**
- **Profession expansion prefix:** `"Midnight"`

Patch-number formula for the addon Interface / patch strings:
`MAJOR*10000 + MINOR*100 + PATCH` → 12.0.5 = `120005`, 12.0.7 = `120007`.

---

## Playbooks by trigger

Pick the trigger that matches what WoW just shipped and do every step. Each step
links to the durable register entry (§ below) for the exact file + source.

### A. Any live patch — including a point patch (x.x.**x**)

Even a tiny point patch flags the addon out-of-date if the TOC Interface isn't
bumped. Do ALL of these together (they are coupled — see §Coupled updates):

1. **Addon TOC Interface** → set `## Interface:` to the new live patch number
   (`MAJOR*10000+MINOR*100+PATCH`). [§3]
2. **Addon header comment** → update `StatSmith.lua:1` to match. [§3]
3. If shipping an addon change: bump `## Version` (`.toc`) **and**
   `ADDON_VERSION` (`.lua`) **in lockstep**, bump the **MSI `Version`** in
   `installer/Package.wxs`, rebuild the MSI, redeploy (see `vps-deploy` skill),
   **and purge Cloudflare**. [§3]
4. Update the **Current game state** block above.

### B. New raid tier (content patch)

1. **WCL zone id** — find it: run `scripts/wcl-smoke.ts` (lists the 20
   highest-id zones with a "frozen" flag) and pick the newest **non-frozen,
   non-PTR / non-M+ / non-Delve raid** zone. Set `WCL_RAID_ZONE_ID` in **`.env`
   AND the prod compose env** (it's read via raw `process.env`, NOT through
   `@/env`, so env-schema validation will NOT catch a missing value). [§1]
2. **Two hard-coded `?? 46` fallbacks** — bump both to the new zone id:
   `snapshot.ts` (professions/parses) and `tracked-member-sync.ts` (Tier-A
   ingestion). These are easy to miss because they're not centralized. [§1]
3. **Journal-instance ids** — for each raid in the new tier add
   `"<Raid Name>": <id>` to `CURRENT_TIER_INSTANCES` in `zone-art.ts`. Find the
   id from Blizzard game-data `GET /data/wow/journal-instance/index` (static
   namespace) or the Wowhead journal-instance URL. This drives calendar
   zone-art + per-raid boss lists. [§1]
4. Likely also a new ilvl cap/bands → do Playbook C.
5. **After deploy: purge Cloudflare** (new behavior can 404 at the CF edge — see
   the cloudflare-stale memory) and run the post-deploy route prewarm.
6. Update the **Current game state** block.

> Encounter/boss ids need NO update — they're resolved dynamically from WCL
> rankings + Blizzard `journal-instance.encounters[]`.

### C. New season / new ilvl cap + tracks

1. **`MAX_ITEM_LEVEL`** in `gear-tracks.ts` → the new tier's highest
   Mythic/Voidforged drop ilvl. Source: Wowhead patch loot guide, or
   Blizzard-verify against stored equipment. [§2]
2. **The 4 gear-track band breakpoints** (`myth/hero/champion/veteran`) in
   `trackForItemLevel()` → shift to the new season's base ilvls (steps of +13).
   Source: Wowhead "Gear Upgrade Tracks" / Catalyst guide. [§2]
3. **`gear-tracks.test.ts`** → update the asserted numbers in **lockstep** or
   the tests break. [§2]
4. Re-check the currency keyword list (`CURRENCY_KEYWORDS`) if the season
   renames the crest/valorstone family. [§2]
5. Update the **Current game state** block.

### D. New expansion

Everything in A–C, plus:

1. **`CURRENT_PROFESSION_EXPANSION`** in `professions-logic.ts` → the new
   expansion-name prefix (e.g. `"Midnight"` → next name). Verify the exact
   string via a live `/professions` probe (it must match the tier name Blizzard
   returns, e.g. "Midnight Blacksmithing"). [§6]
2. **`ENCHANTABLE_SLOTS`** in `gear-audit.ts` → re-verify which slots are
   enchantable this expansion (Midnight added Head/Shoulder, removed
   Wrist/Back). A wrong set false-flags "missing enchants" on every character.
   Source: Wowhead/Method/Icy-Veins enchanting guide. [§9]
3. **New class?** add it to `WOW_CLASS_NAMES`, `WOW_CLASS_COLORS`, and the
   `TANK_SPECS`/`HEAL_SPECS` sets in `wow.ts` (newest today is class id 13 =
   Evoker). [§8]
4. Re-verify the Blizzard + WCL difficulty-id maps still hold. [§5]
5. Update the **Current game state** block and this skill's intro values.

---

## Reference register

Durable anchor = the **constant/key name** (line numbers drift; grep the name).
Paths are relative to this skill file.

### §1 — Raid tier / zones

| Where | Const / value | What | Update source |
|---|---|---|---|
| [.env](../../../.env) (`WCL_RAID_ZONE_ID=46`) + **prod compose env** | `46` | The WCL `worldData` zone id for the current tier — **the single most important per-tier value**. Raw `process.env`, not in `@/env`. | `scripts/wcl-smoke.ts` → newest non-frozen raid zone |
| [zone-art.ts](../../../src/server/calendar/zone-art.ts) | `CURRENT_TIER_INSTANCES` `{Voidspire:1307, "March on Quel'Danas":1308, Dreamrift:1314}` | Raid name → Blizzard journal-instance id (WCL combines the tier into zone 46 and can't split it). Drives calendar art + per-raid boss list. | Blizzard `GET /data/wow/journal-instance/index` or Wowhead |
| [snapshot.ts](../../../src/server/api/routers/snapshot.ts) | `?? 46` | Hard-coded fallback zone id (professions/parses). | Bump with the env pin |
| [tracked-member-sync.ts](../../../src/server/ingestion/jobs/tracked-member-sync.ts) | `?? 46` | Same fallback in Tier-A WCL ingestion. | Bump with the env pin |
| [client.ts](../../../src/server/ingestion/warcraftlogs/client.ts) | `currentRaidZoneId()` resolver + `isNonRaid` regex | Auto-resolves the tier (env pin → Redis 6h → live `worldData.zones`). Usually no change; verify the name-regex still excludes any new non-raid zone type. | n/a — set the env pin if it mis-picks |
| [scripts/diag-wcl-zone46.ts](../../../scripts/diag-wcl-zone46.ts) | `[46, 51]` | Diagnostic probe (non-critical). | Update the id list when investigating a new tier |

> **Sporefall caveat:** a pre-release journal-instance id `1312` (name "Midnight",
> 4 encounters) is **unreconciled** — verify the real id/name on release before
> adding to `CURRENT_TIER_INSTANCES`. The schema already stores `zoneId` per
> report, so a mid-season raid addition needs no schema change.

### §2 — Item level

| Where | Const | What | Update source |
|---|---|---|---|
| [gear-tracks.ts](../../../src/lib/gear-tracks.ts) | `MAX_ITEM_LEVEL = 298` | Highest legit ilvl this tier; over-cap warning threshold. | Wowhead patch loot guide / Blizzard-verify against stored gear |
| [gear-tracks.ts](../../../src/lib/gear-tracks.ts) | `trackForItemLevel()` bands `myth≥272, hero≥259, champion≥246, veteran≥233` | Gear-track breakpoints (Season 1 bases, +13 steps). Drives tier-set tracker + vault pip colours. | Wowhead "Gear Upgrade Tracks" / Catalyst guide |
| [gear-tracks.test.ts](../../../src/lib/gear-tracks.test.ts) | `289,298,272,259,246,233` | Tests asserting the bands — **update in lockstep**. | Mirror the band changes |
| [snapshot.ts](../../../src/server/api/routers/snapshot.ts) | `CURRENCY_KEYWORDS` `["catalyst","crest","valorstone","coffer","spark","mettle","kej"]` | Currency classification by NAME (crest ids are NOT hard-coded). | Add a keyword if a new expansion renames the crest family |

> The exact upgrade-track **bonus-ID → track** map would resolve band overlaps
> precisely, but it is **UNVERIFIED and NOT in code** (Blizzard exposes no
> bonus-ID semantics). Sourcing it needs a raidbots `bonuses.json` / Wowhead
> dump. Bands above are the verified approximation.

### §3 — Addon (Stat Smith)

| Where | Const | What | Update source |
|---|---|---|---|
| [StatSmith.toc](../../../addon/StatSmith/StatSmith.toc) | `## Interface: 120005` | **= the live patch number.** Wrong = addon flagged out-of-date. | Patch notes → `MAJOR*10000+MINOR*100+PATCH` |
| [StatSmith.lua](../../../addon/StatSmith/StatSmith.lua) | header comment (line 1) | Mirrors the patch. | Match the TOC |
| `.toc` `## Version` + `.lua` `ADDON_VERSION` | `1.2.0` | Addon semver — **two places in sync**. | Bump together on any addon change |
| [StatSmith.lua](../../../addon/StatSmith/StatSmith.lua) | `SCHEMA_VERSION = 3` | Payload schema version (server parses by it). | Bump ONLY when the payload shape changes — not for patch bumps |
| [installer/Package.wxs](../../../installer/Package.wxs) | `Version="1.0.18.0"` | MSI installer version (single source of truth, read by `installer/build.ps1`). | Bump for any installer/addon redeploy |

> Addon-side season/tier is fully dynamic (`C_MythicPlus.GetCurrentSeason()`,
> delve-season API) — no hard-coded season numbers to change.

### §4 — Ability ids

| Where | Const | What | Update source |
|---|---|---|---|
| [queries.ts](../../../src/server/ingestion/warcraftlogs/queries.ts) | `REZ_ABILITY_IDS = [20484, 20707, 61999, 391054]` | Combat-rez spells for `brez_economy` (Rebirth / Soulstone / Raise Ally / Intercession). `REZ_FILTER_EXPRESSION` derives from it. | Stable; extend only if a new class/item rez appears (Wowhead spell search) |
| [defensive-cooldowns.ts](../../../src/lib/defensive-cooldowns.ts) | `DEFENSIVE_ABILITIES` (~36 ids) | Personal-defensive allowlist for `cooldown_usage` — `id → name → class → cooldownSec → kind`. Drives the WCL Buffs/Casts filter + the "defensive active at death" analytic. | Spell **ids** are stable; cooldown **durations** drift with talent reworks — **re-verify durations every content patch** (Wowhead/Icy-Veins class guides). Add new class/spec defensives when a class is added. |

> Tier-set ids / bonus ids are NOT hard-coded — detected dynamically via
> `item.set.item_set.id`.

### §5 — Season / M+ / difficulty

All dynamic EXCEPT the difficulty-id name maps (Blizzard `{17:LFR,14:N,15:H,16:M}`
and WCL `{5:M,4:H,3:N,1:LFR}`), which are **stable across patches** and live in
[snapshot.ts](../../../src/server/api/routers/snapshot.ts) and the widget files
(`wcl-parses.tsx`, `parses-heatmap.tsx`, `bench-equity.tsx`, `prog-curve.tsx`,
`learning-curve.tsx`). M+ season id, dungeon pool, vault thresholds, PvP season
are all resolved live — no maintenance.

### §6 — Professions / expansion

| Where | Const | What | Update source |
|---|---|---|---|
| [professions-logic.ts](../../../src/lib/widgets/professions-logic.ts) | `CURRENT_PROFESSION_EXPANSION = "Midnight"` | Expansion-name prefix matching the current profession tier ("Midnight Blacksmithing"). Expansion-level only. | Live `/professions` probe → exact tier-name prefix |
| [professions-logic.ts](../../../src/lib/widgets/professions-logic.ts) | `PRIMARY_PROFESSIONS` (11) | Primary profession list (gap detection). | Only if WoW adds a primary profession |
| [professions-logic.test.ts](../../../src/lib/widgets/professions-logic.test.ts) | fixtures | Must match the expansion-name logic. | Update if the match logic changes |

> Recipe-category cache key `prof-cat:{region}:{profId}:{tierId}` self-invalidates
> per tier — no manual change. `expansionId` flows dynamically from the addon.

### §7 — Journal / dungeon-instance ids

Only the three raids in `CURRENT_TIER_INSTANCES` (§1) are hard-coded. All other
journal/dungeon ids are passed as params to dynamic Blizzard endpoints. No
maintenance.

### §8 — Talents / specs / classes

All dynamic via Blizzard `characterSpecializations`. Class names/colors + role
specs in [wow.ts](../../../src/lib/wow.ts) (`WOW_CLASS_NAMES`,
`WOW_CLASS_COLORS`, `TANK_SPECS`, `HEAL_SPECS`) are by NAME and stable — only
touch them when a **new class/spec** ships (newest = id 13 Evoker).

### §9 — Enchant slots (expansion-coupled)

| Where | Const | What | Update source |
|---|---|---|---|
| [gear-audit.ts](../../../src/server/ingestion/gear-audit.ts) (grep `ENCHANTABLE_SLOTS`) | `HEAD, SHOULDER, CHEST, LEGS, FEET, FINGER_1, FINGER_2, MAIN_HAND` | Which slots are enchantable — drives the "missing enchants" audit. Midnight added Head/Shoulder, removed Wrist/Back. Wrong list = false flags on everyone. | Wowhead/Method/Icy-Veins enchanting guide (expansion-level) |

### §10 — WCL partition

Handled dynamically (read from `rankings[].allStars.partition`, `-1` sentinel
rejected) in [snapshot.ts](../../../src/server/api/routers/snapshot.ts). No
hard-coded partition. A new partition appears automatically.

---

## Coupled updates (the "don't ship half of it" list)

1. **New raid tier:** `WCL_RAID_ZONE_ID` in `.env` **AND** prod compose env →
   the two `?? 46` fallbacks → `CURRENT_TIER_INSTANCES` → (usually) ilvl bands →
   **Cloudflare purge + route prewarm** after deploy.
2. **New ilvl cap/bands:** `MAX_ITEM_LEVEL` + the 4 bands in `gear-tracks.ts`
   **AND** `gear-tracks.test.ts` expectations.
3. **Any live patch:** `## Interface:` (toc) + `StatSmith.lua` header comment +
   (if shipping) `## Version`/`ADDON_VERSION` in lockstep + `Package.wxs` MSI
   Version + rebuild MSI + redeploy + **Cloudflare purge**. The MSI re-stages the
   `.toc`/`.lua` into the WoW folder, so a TOC bump only reaches users via a
   rebuilt+redeployed MSI.
4. **New expansion:** `CURRENT_PROFESSION_EXPANSION` + re-verify
   `ENCHANTABLE_SLOTS` + add any new class to `wow.ts` + re-verify difficulty
   maps.

---

## Data-source cheat-sheet

| You need… | Get it from |
|---|---|
| New WCL tier zone id | `scripts/wcl-smoke.ts` (newest non-frozen raid zone) |
| New journal-instance id | Blizzard `GET /data/wow/journal-instance/index` (static ns) or Wowhead journal URL |
| New live patch number | Patch notes → `MAJOR*10000+MINOR*100+PATCH` |
| New ilvl cap / track bands | Wowhead patch loot guide + "Gear Upgrade Tracks" / Catalyst guide |
| New enchantable slots | Wowhead/Method/Icy-Veins enchanting guide |
| New profession-expansion prefix | Live `/professions` probe (exact tier-name string) |
| New rez/defensive ability id | Wowhead spell search; verify live via WCL |

---

## Gotchas

1. **`WCL_RAID_ZONE_ID` is raw `process.env`, not `@/env`** — it won't show up in
   env-schema validation; easy to forget in the prod container env. (See
   `warcraftlogs-api` skill gotcha.)
2. **The `?? 46` fallbacks are decentralized** — there are TWO (in `snapshot.ts`
   and `tracked-member-sync.ts`) plus the env pin plus `46` baked into the
   `diag-wcl-zone46.ts` filename. Grep `?? 46` and the zone number before
   declaring a tier roll done.
3. **`NEXT_STEPS.md` is STALE** — it references Manaforge Omega / zone **44**
   (The War Within) and contradicts the live code (pins **46** / Midnight). Do
   NOT trust it as the procedure; the live source of truth is `.env` comments +
   `scripts/wcl-smoke.ts` + this skill.
4. **`parses-heatmap.tsx` mentioning zone 44** is intentional (it documents the
   prior tier as an example of a stale zone to exclude) — not a bug to "fix".
5. **`docs/research/widget-and-preparedness-research.md`** holds the Sporefall /
   12.0.7 UNVERIFIED checklist — useful as the verification list on the next
   patch, but it's a research doc, not code.

---

## Related

- `warcraftlogs-api` — zone resolution, points budget, the `WCL_RAID_ZONE_ID`
  gotcha.
- `blizzard-api` — journal-instance + professions endpoints, namespaces.
- `vps-deploy` — the rebuild/redeploy + Cloudflare-purge sequence the addon and
  tier rolls depend on.
