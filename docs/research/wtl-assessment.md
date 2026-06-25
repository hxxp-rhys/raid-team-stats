# wow.tools.local (WTL) — Setup, Fit, and Patch-Maintenance Assessment

**Date:** 2026-06-25  ·  **WoW build assessed:** `12.0.7.68275` (expansion *Midnight* 12.0, patch *Revelations* 12.0.7)
**Method:** three-agent deep-research deliberation (`.claude/deliberation.md`) over an empirical capability ledger; every significant claim dual-validated by independent agents.
**Status:** Tasks 1–3 complete. This is a *determination* (assessment), not a built integration. The only recommended code changes are documentation (skill) updates; one optional user-facing feature (C8) is left owner-gated.

---

## TL;DR

- **WTL is set up, indexed, and verified** on this machine (localhost:5000, build `12.0.7.68275`, `readOnly` enforced, bound to loopback). Dual-validated PASS/PASS.
- **WTL must never be a runtime or CI dependency.** It is a localhost server that reads the WoW client installed on the maintainer's machine; production (`10.10.0.160`) and CI have neither WoW nor WTL. This is an architectural hard constraint, unanimous across all three deliberation agents.
- **Best fit = a developer-time / patch-day verification & sourcing aid**, surfaced as documented source options in the `wow-patch-upgrade` skill — *not* a code dependency. This matches the project's API-first design and its "research first, never guess" rule.
- **WTL genuinely helps patch updates for a subset** of the patch-coupled constants (it can *source* journal-instance IDs and the profession-tier prefix; it can *verify* defensive-cooldown durations, the delve achievement window, and combat-rez IDs) — converting several "trust a third-party guide" steps into "confirm against the installed client."
- **WTL cannot help the most frequent painful edit** (the seasonal item-level cap + upgrade-track bands) and several others. It reduces lookup effort and error; it does **not** eliminate patch-day edits (a "current" season/tier pointer is still maintained by hand).
- **One optional user-visible win:** tier-set 2pc/4pc *bonus text* (C8) — uniquely sourceable from WTL — could enrich the tier-set tracker via a committed build-time JSON snapshot. Recommended only if the owner wants that feature.

---

## Task 1 — WTL setup & verification (DONE)

| Item | Result |
|---|---|
| WoW install | `C:\Program Files (x86)\World of Warcraft` (retail, `.build.info` present), build `12.0.7.68275`, region us / enUS |
| Runtime | .NET 10.0.300 present; WTL `0.9.4` (prebuilt win-x64) extracted to `C:\wtl`, launched detached (PID seen at 26444) |
| Config | `C:\wtl\config.json` nested under `"config"` wrapper; `readOnly:"true"`, `wowFolder` = the install root |
| Indexing | First-run indexing completed; serves DB2 on-demand from CASC in-memory |
| Verification | `/casc/buildname`=`12.0.7.68275`; `/dbc/peek/SpellName id=17`="Power Word: Shield"; `/dbc/data/SpellName` recordsTotal=404,171; WTL-only `TraitTree`/`PvpTalent` headers return real columns |
| Security | `readOnly` enforced (`/sql` does not execute — returns 500 via a Forbid path); bound to `127.0.0.1`+`::1` only, no `0.0.0.0` |
| Dual validation | Validator A (adversarial correctness): PASS (cross-checked spell IDs + current build vs Wowhead, negative controls). Validator B (security/operational): PASS (readOnly, loopback, process health, `/dbc/info` anomaly proven non-blocking). |

**Operational gotchas discovered (live API vs the WTL skills):**
- **`/dbc/find` and `/dbc/data` require an explicit `?build=<BUILD>`** — `?build=?` fails *silently* on `/dbc/find` (returns `[]`, looking like "no rows"). Only `/dbc/header` and `/dbc/peek` resolve `?build=?`. (This misled one deliberation agent into a false "capability broken" conclusion.)
- **`/dbc/info` returns 0 tables / "Could not find DBCs on disk"** here — WTL serves DB2 on-demand from CASC and does not pre-extract to the on-disk `dbcs/` folder that `/dbc/info` enumerates. Query tables directly (header/peek/find/data); do not rely on `/dbc/info` for the catalog in this mode.
- **`/sql` returns HTTP 500, not the documented 403**, under `readOnly` (WTL issues a `ForbidResult` but has no ASP.NET auth scheme registered). The endpoint is still genuinely blocked (no SQL executed) — cosmetic only.

These are corrected in the `wtl-query`/`wtl-setup` skills in the same session (per the project's "fix the skill when the live API contradicts it" rule).

---

## Method & evidence base

1. **Architecture map** — an independent agent read the relevant project files *in full* and mapped every game-data source and every patch-coupled constant (file:line).
2. **Empirical capability ledger** — an independent agent ran live WTL queries for each candidate and recorded whether WTL can **CAN-SOURCE** (authoritatively provide), **CAN-VERIFY** (confirm a value set elsewhere, but not enumerate), or **CANNOT**.
3. **Deliberation** — three agents with distinct epistemic identities (Skeptic / Synthesist / Pragmatist) independently answered "best fit" and "patch help," then their conclusions were converged on the merits and dual-validated; contested empirical claims were re-probed against live WTL before acceptance.

### Capability ledger (live-verified, build 12.0.7.68275)

| # | Candidate (project location) | Verdict | Evidence |
|---|---|---|---|
| C1 | Raid journal-instance IDs (`zone-art.ts:34-43`) | **CAN-SOURCE** | `JournalInstance` 1307/1308/1314/1305 names match exactly; current tier = `JournalTier` 516 "Midnight" / 505 "Current Season" → `JournalTierXInstance`; bosses via `JournalEncounter` |
| C2 | Max item level 298 + upgrade-track bands (`gear-tracks.ts:31,71-80`) | **CANNOT** | Seasonal/derived; no Midnight rows in `UIModifiedInstance`; no canonical "band minimum" column |
| C3 | Delve-stat achievement window (`StatSmith.lua:546`) | **CAN-VERIFY** | `Achievement` 61779–61789 = "Midnight Tier 1–11 delves completed" (Category 15572); titles carry a "Midnight " prefix |
| C4 | Defensive cooldown durations (`defensive-cooldowns.ts`) | **CAN-VERIFY** (borderline source) | Accurate seconds, but must pick among `RecoveryTime` / `CategoryRecoveryTime` / charge path — Shield Wall is 180s only via `SpellCategory.ChargeRecoveryTime`, not its 8s `RecoveryTime` |
| C5 | Combat-rez IDs (`queries.ts:736`) | **CAN-VERIFY** | 20484/20707/61999/391054 names confirmed; no "is-combat-rez" flag to discover new ones |
| C6 | Profession expansion prefix "Midnight" (`professions-logic.ts:19`) | **CAN-SOURCE** | `SkillLine` rows 2906-2918 "Midnight <profession>", `ParentTierIndex=15` (newest tier) |
| C7 | Enchantable slots (`gear-audit.ts:19-28`) | **CANNOT** | No DB2 column maps an enchant → permitted equipment slot; `ItemEnchantmentTemplate` not extractable |
| C8 | Tier-set 2pc/4pc SpellIDs + Threshold + **rendered text** | **CAN-SOURCE** | `find/ItemSetSpell?build=<BUILD>&col=ChrSpecID&val=73` → current Midnight set 1990 (2pc 1264879 / 4pc 1264880) + `/dbc/tooltip/spell` renders the bonus text. (Requires explicit build; select current set by ChrSpecID + newest set, not global max.) |
| C9 | M+ dungeon id→name | **CAN-SOURCE but REDUNDANT** | `MapChallengeMode` × `MythicPlusSeasonTrackedMap` (season 34) works — but the addon already emits `mapName` via `C_ChallengeMode.GetMapUIInfo` (`StatSmith.lua:313-318,327-334`); the `keystones.tsx:12-13` "null" comment is stale |
| C10 | Full talent-tree topology → spells | **CAN-SOURCE but NO CONSUMER** | Full FK chain resolves to real spells (Prot Warrior spec 73 → tree 880 → 260 nodes → e.g. Sidearm/Battle Stance) — but the project treats talents as opaque loadout strings; nothing renders a tree |

**Cross-cutting caveat (all agents):** every "current" derivation is gated on **one manually-tracked pointer** (`JournalTier` 516/505, M+ `DisplaySeasonID` 34, highest profession `ParentTierIndex`, current `ItemSetID`-per-spec). WTL changes *where a value is looked up*; it does not remove the pointer-bump.

---

## Task 2 — How WTL best fits THIS project

The project's game data splits into **live per-player state** (Blizzard / WCL / Raider.IO / the StatSmith addon — resolved at runtime, never hardcoded) and a **small static patch-coupled reference set** (the ~20 hardcoded constants). WTL belongs to **neither runtime axis**. It is a third, orthogonal thing: a **local, authoritative game-truth source** the *maintainer* consults — today that role is filled by third-party guides (Wowhead / Icy-Veins / Method), which lag the patch and can be wrong.

**Recommended fit, by layer:**

1. **Developer-time / patch-day verification & sourcing aid — PRIMARY, adopt.** Register WTL in the `wow-patch-upgrade` skill as an authoritative *local* source option for the constants it can serve (C1, C6, and verify-grade C4/C3/C5). No code, no runtime/build dependency, ~zero risk, and it directly serves the project's "research first, never guess" mandate. This is the genuine "integration": **documentation, not a dependency.**
2. **Build-time committed snapshot — NARROW, optional.** Justified only where the data is rich and otherwise unavailable. The single candidate that clears that bar is **C8 tier-set bonus text** (a `scripts/gen-*.ts` run locally on patch day that writes a committed JSON the website imports — WTL is never called at runtime). Owner-gated: build it only if the tier-set bonus tooltip is a wanted feature.
3. **Runtime / production — EXCLUDED (hard).** Prod and CI cannot run WTL. Any request-time or job-time call to `localhost:5000` is an instant outage. Guardrail, not a trade-off.

**Explicitly do not:** wire a runtime client; add a build step that breaks CI/contributor machines (which lack WTL); check in a standing "source-of-truth" snapshot that silently goes stale; or build the C10 talent pipeline (impressive, but this project has no talent-tree consumer — that capability is the right fit for the sibling *wow-tankgear* tool the WTL skills were originally written for).

---

## Task 3 — Does WTL help future patch / content-release updates?

**Yes, meaningfully, for a subset — as a verification/sourcing aid, not an automation that removes edits.**

| Patch-coupled reference | WTL role | Net effect on patch-day work |
|---|---|---|
| Journal-instance IDs (C1) — *the skill's self-described "one still-manual tier step"* | **SOURCE** | Authoritative local id+name+boss-count the moment the client patches; no waiting on Wowhead, no pre-release guess (cf. the Sporefall `1312`-guess-was-wrong episode). Still must bump the `JournalTier` pointer. |
| Profession expansion prefix (C6) | **SOURCE** | Equivalent to the existing `/professions` probe; changes once per expansion. Low value. |
| Defensive cooldown durations (C4) — *the skill's most recurring error-prone step* | **VERIFY** | Replaces googling ~36 abilities with a local authoritative check. Must not auto-source (the Shield Wall charge-path trap). Real toil reduction as a guided verify. |
| Delve achievement window (C3), combat-rez IDs (C5) | **VERIFY** | Confirm-by-id; low frequency, low toil. Cheat-sheet line each. |
| **Item-level cap 298 + upgrade-track bands (C2)** — *the most frequent, highest-pain seasonal edit* | **CANNOT** | WTL does not help. Stays on Wowhead. |
| Enchantable slots (C7) | **CANNOT** | No DB2 slot mapping. Stays on Wowhead. |
| M+ dungeon names (C9) | **REDUNDANT** | Addon already supplies `mapName` live. |
| WCL zone/encounter IDs, tier resolution | n/a (auto-resolved from WCL) | WTL could *cross-check* a `.release`-boundary mis-resolution — latent, untested, rare. |

**The emergent patch-day workflow:** for each game-truth constant a patch touches, **query WTL first** (source or confirm against the installed client), then commit the literal; fall back to Wowhead only for C2/C7. A small optional `scripts/wtl-verify-patch-refs.ts` could batch-assert every WTL-knowable constant against the live build and **fail loudly on drift** — turning "did I forget to bump something?" into a checked step (proposal; not built here).

**Honest bounds:** WTL reduces lookup time and error and adds drift-detection potential, but it does **not** eliminate patch-day edits — the highest-frequency painful edit (C2) is out of reach, and every "current" lookup still needs one human-maintained pointer. WTL itself can break on patch day (old WTL vs new client schema) and must be re-indexed, so it is an aid, not a guarantee.

---

## Recommendation (actionable)

1. **Adopt now (documentation):** add WTL to the `wow-patch-upgrade` skill as a local authoritative source for C1/C6 (source) and C4/C3/C5 (verify), with the explicit-build gotcha and an explicit "WTL CANNOT do C2/C7" note so future maintainers don't waste time. *(Done this session.)*
2. **Fix now (mandated):** correct the `wtl-query`/`wtl-setup` skills for the live-API contradictions found (find/data explicit-build, `/dbc/info` on-demand behavior, `/sql` 500-not-403, the now-present standard WoW path). *(Done this session.)*
3. **Optional, owner-gated (feature):** C8 tier-set bonus-text enrichment as a committed build-time JSON snapshot → tier-set tracker tooltip. The one genuinely user-visible win. Estimate M; tail risk if some hero/sub-tree tooltips render empty.
4. **Do not build:** runtime/CI WTL dependency; C2/C7/C9 generators; C10 talent pipeline.

## Negative results worth preserving
- WTL **cannot** source the seasonal item-level cap/bands (C2) or enchantable slots (C7) — the most frequent / a recurring patch edit, respectively.
- C9 (M+ names) and the WCL-masterdata spell metadata are **already provided** by the live pipeline; WTL would duplicate them.
- C10 (talent topology) is WTL-unique but has **no consumer** in this project.
