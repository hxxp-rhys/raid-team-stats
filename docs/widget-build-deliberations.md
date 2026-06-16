# Widget-build deliberations log

Working log of questions that required a 3-agent deliberation during the
"Create these widgets" task, per the special instructions. Final report is
compiled from this at the end.

---

## D1 — professions: what should the widget surface in v1?

**Question:** Blizzard's `/professions` endpoint gives, per character: primary
(max 2) + secondary professions, each with current-expansion-tier skill `X/Y`
and a list of KNOWN recipes (→ a count). It does NOT give a "total recipes
available per tier" denominator, nor any "high-value recipe" classification.
What should v1 display, given the hard ~99%-accuracy rule?

**Options:**
- (a) Profession + current-tier skill `X/Y` + raw known-recipe **count**. Every
  field comes straight from the endpoint; verifiable live + in-game.
- (b) Recipe **coverage %** (known / total). Denominator is not in the endpoint
  and not ingested → cannot be made accurate today.
- (c) "Who can craft `<high-value item>`". Needs a hand-curated, per-patch
  recipe-id allowlist → rots each patch; cannot hold 99% accuracy.

**Deliberation (3 agents, distinct lenses):**
- Raid-leader-UX lens → (a), framed as a "crafter roster" answering "who do I
  ping?"; add a coverage-GAP signal (professions nobody on the team has) since
  absence is 100% knowable.
- Data-accuracy lens → (a) only; pin the current-tier `tier.id`s (never
  max/last); handle absent-vs-zero; locale-union names; count recipes within the
  resolved current tier only.
- Product/user-choice lens → (a) in the standard latest-per-character table;
  give choice via a profession filter + show-secondaries toggle; both (b)/(c)
  bolt on later as additive overlays with no rework.

**Consensus / chosen answer:** Ship **scope (a)** with accuracy guards. Layout:
character-row table by default (consistent with every other widget) + a toggle
to **pivot by profession** (answers "who can craft X" and shows the coverage gap
of uncovered professions) + a **show-secondaries** toggle (default off). The
recipe count is labeled "Known recipes", never a percentage.

**Why:** Unanimous on (a) because it is the only fully-accurate option today and
the project rule is non-negotiable on accuracy. The two-view layout + two toggles
deliver meaningful user choice (the emphasized priority) without complexity creep
and stay inside the app's established widget pattern. (b) and (c) are deferred —
not shipped wrong — and both upgrade additively once their data sources exist
(total-recipes index for %, curated allowlist for craft-capability).

**Deferred to v1.1+ (documented upgrade path):** coverage %, high-value craft
matrix, click-to-expand known-recipe name list.

---

## D2 — professions: show a player's known recipes "sorted like in-game"

**Question:** The user asked for a per-player button that lists that player's KNOWN
recipes "sorted like it is in game". A live probe established: the character
`/professions` `known_recipes` is a FLAT `{id,name}` list with NO meaningful order
and NO category. The game-data `/data/wow/profession/{id}/skill-tier/{tierId}`
DOES return `categories[]` in exact in-game display order (Recrafting → Profession
Equipment → Weapons → Armor → … → House Decor), static per patch. So how to sort,
and how to build it?

**Options:**
- (A) TRUE in-game sort: group the player's known recipes by the game-data
  categories, in category order. Needs a new (cacheable) game-data source.
- (B) Alphabetical by name. Buildable with zero new source, but NOT in-game order.
- (C) Raw API order. Meaningless (verified).

**Deliberation (3 agents, distinct lenses):**
- UX → (A); the user asked for the in-game book, reproduce the artifact
  (recognition over recall). One lightbox per player covering all professions;
  known-only; omit empty categories (category list = capability summary);
  add a search box (matches the app's Members-modal idiom); collapsible categories
  OUT for v1.
- Data-accuracy → (A) clears the 99% bar — it's a lossless re-ordering of the
  player's own known set (game-data only supplies order/grouping, never
  membership). MUST: dedupe by id (cross-listed → once), and append a trailing
  "Other" bucket for any known recipe not in a category (post-patch lag) so a
  known recipe is never dropped. Pseudo-categories (Appendix/Terms/Stats) drop
  out naturally (no real recipe ids). Fall back to alphabetical only if the
  game-data fetch fails.
- Architecture → leanest sound build: new on-demand `snapshot.professionRecipes`
  procedure reading the RAW payload; new `professionSkillTier` endpoint
  (static-{region} namespace) + passthrough schema; Redis cache keyed
  `prof-cat:{region}:{profId}:{tierId}` (long TTL); pure grouping helper in
  professions-logic.ts (+tests). NO DB table, NO ingestion job, NO icons. Do NOT
  touch latestForTeam.

**Consensus / chosen answer:** Build **(A)** — the true in-game category sort.
Per-player button on the recipe count → a single lightbox covering all the
player's professions, known recipes grouped by game-data category in in-game
order, with a search box. Dedupe + "Other" orphan bucket guarantee accuracy.
Alphabetical is the graceful fallback if the game-data category fetch fails.
Implemented via an on-demand tRPC procedure + Redis-cached game-data lookup; no
new DB table or ingestion.

**Why:** the user's explicit ask ("like in game") + the confirmed availability of
the game-data category order make (A) both correct and feasible, and it clears
the accuracy bar as a lossless re-ordering. Lean by reusing existing seams
(client static-namespace requests, Redis cache, the Modal, the pure logic module).

### D1a — current-tier resolution (sub-decision, resolved from a live payload probe)

A live `/professions` probe of 4 real team characters established the accuracy
foundation:
- `primaries`/`secondaries` are OMITTED when a character has no professions
  (both optional in the schema).
- Per-tier skill is authoritative; the profession-level `skill_points` is absent
  for tiered professions and present only for legacy non-tiered ones (Archaeology
  `800/800`, `tiers: []`).
- Each expansion contributes exactly one tier named `"<Expansion> <Profession>"`.
  Current (Midnight) tier ids observed: Blacksmithing 2907, Mining 2916,
  Cooking 2908, Fishing 2911 (highest id per profession in the data).
- Caps differ per profession (Fishing 300, crafting 100) — read `max_skill_points`
  live, never hardcode. `known_recipes` is per-tier; count within the current
  tier only.

**Chosen current-tier resolver:** match the tier whose name starts with the
current-expansion constant (`"Midnight"`), NOT the max tier id. Max-id is unsafe:
a character with the profession but who hasn't leveled the Midnight tier would
surface a stale older-expansion "maxed" number. If no current-expansion tier
exists → render "not leveled (current tier)", never an older tier. Legacy
non-tiered professions (Archaeology) fall back to the profession-level skill.
The expansion constant is bumped per expansion (same model as the season/zone
pins the codebase already maintains).

---

## D3 — first_death_ledger: rate denominator under partial backfill

**Question:** The deaths layer (WCL `events(dataType: Deaths)`) only populates
when GRS (re)fetches a report. Existing/frozen reports have no deaths until a
backfill runs. With first-death **rate = first-deaths / pulls-present**, a
pull from an un-backfilled report has no death data — so should it count in
the denominator? (Counting it silently understates every player's rate while
the backfill is in flight; the first validation run showed Midnight Falls at
"127 wipes / 0 deaths" for exactly this reason.)

**Options:**
- (a) Denominator = all wipe pulls present. Simple, but understates rates until
  100% backfilled, and an honest leader can't tell a real 0 from a data gap.
- (b) Denominator = **deaths-OBSERVED** wipe pulls present (a pull is observed
  iff its report has ≥1 death row). Robust to partial backfill; the rate always
  means "of the pulls we have death data for". Encounter ranking also gated on
  ≥5 OBSERVED wipes so thin data never ranks.
- (c) Block the widget entirely until a full backfill completes.

**Decision: (b).** Resolved by data validation + the two-worker review (not a
3-agent deliberation — the research already specified "rates per pulls-present";
this was the correctness refinement of *which* pulls). Observed-ness is computed
from ALL deaths in a report (team or not), so a wipe where only a non-team
player died first still counts the pull as observed. A coverage note ("rates
over X of Y wipes — deaths still backfilling") keeps it honest while a backfill
is mid-flight. **Why:** a raid leader benching on this number must trust it;
(a) would quietly mislead, (c) would hide a working widget for hours.

## D4 — first_death_ledger: avoiding an infinite deaths re-fetch

**Question:** The self-healing backfill sweep selected reports with
`deaths: { none: {} }`. A genuinely death-free wipe (early `/wipe` reset before
anyone dies) stays death-free after fetch, so it matched forever — re-paying
WCL points every run. (Surfaced by the ingestion review.)

**Decision:** Added `WclReport.deathsFetchedAt` (null = never attempted) and
switched the sweep to `deathsFetchedAt: null`. A fetched report — even one with
zero deaths — is stamped and drops out permanently. **Why:** a permanent
low-grade points leak is unacceptable on a shared 17k/hr budget, and the marker
also distinguishes "no deaths" from "not yet looked", which the widget's
observed-gate (D3) depends on being able to trust over time.

---

## D5 — attendance_ledger: what does the addon collect, given one unverified Lua probe?

**Question:** The research's raidObserver block reads BOTH observed raid
presence (`IsInRaid`/`GetRaidRosterInfo` — all VERIFIED) AND in-game guild
calendar SIGNUPS (`C_Calendar.OpenEvent` → invites — the slate's ONE remaining
unverified Lua probe, flagged `SecretInChatMessagingLockdown`). I can't run an
in-game probe. What does the addon collect for v1?

**Options:**
- (a) Both presence + in-game calendar signups. Maximal, but ships an
  unverified, secret-guarded API path that could silently no-op or error.
- (b) Observed presence ONLY; take SIGNUPS from the first-party website
  calendar (EventSignup) which already exists. The widget merges observed-vs-
  signed without touching the unverified Lua.
- (c) Block the whole widget until the in-game probe is run.

**Decision: (b).** This is the research's own documented degradation path
("ship without the signup column — presence/lateness remain fully verified")
applied at the source: the addon collects only the VERIFIED presence APIs
(roster, online, subgroup, role, instance, first/last-seen for punctuality),
and the widget gets signups from the website calendar (which the design doc
already names as the first-party source of truth). **Why:** every API the
addon now calls is verified, so the collector can't silently fail in a way I
can't test; signups already exist first-party; and the in-game calendar lane
can be added later behind feature-detection without reworking anything (the
payload schema + RaidNightObservation already leave optional slots for it).
The companion app stays a pure pipe — new addon fields ride the existing
RTS1: export with zero companion changes.

## D6 — attendance_ledger: the "night" unit + cross-observer merge

**Question:** Two officers running the addon observe the SAME raid night but
each addon stamps its own session id (its local start epoch). How do their
presence observations become ONE night?

**Decision:** Cluster observations by TIME PROXIMITY (an 8h gap opens a new
night), assigning all observations in a cluster a shared key, then union their
presence (earliest firstSeen, latest lastSeen, widest window). A night is then
matched to the nearest calendar RaidEvent within 4h to pick up its SCHEDULED
start (the honest late-threshold anchor) + its signups. **Why:** session ids
can't merge across observers; time-proximity is robust to clock skew and to
one observer joining late, and the union means a single officer with the addon
covers the whole raid (the research's "structurally weakest coverage
requirement"). Only OBSERVED nights count toward the % — a scheduled raid no
observer saw is excluded, never scored as a roster-wide absence.

## D7 — attendance_ledger: review-driven hardening

**Decisions (from the two-worker review):** (1) Clamp `endedAt ≥ startedAt`
server-side — the addon stamps both from wall-clock `time()`, so a backward
clock correction could otherwise persist a negative-length night. (2) Resolve
observed raid names by name AND name+realm (GetRaidRosterInfo emits
"Name-Realm" cross-realm), marking a first-name shared by two team members on
different realms as ambiguous rather than mis-attributing it. **Why:** both are
cheap defenses against real (if low-probability) data-corruption / mis-
attribution that the addon's wall-clock + name-keyed nature invites.

---

## D8 — learning_curve: what IS the learning signal? (raw deaths are saturated)

**Question:** The obvious "learning = death-rate decay over pulls" metric fails:
on a WIPE almost everyone dies, so death rate ≈ 1.0 early AND late — zero
signal. Validated against real Eclipse data: every player read "flat 1.00→1.00".
What signal actually discriminates?

**Decision:** Use **early-death rate** (death order ≤ 2 — being among the first
to fall, the deaths that CAUSE the wipe cascade), not raw death rate. Only ~3
players die "early" per wipe, so it's not saturated. Re-validated against real
data: it discriminates cleanly (Thugnastty 0.39→0.10 improving, Agriás
0.04→0.11 regressing on Chimaerus). Survival-time (how deep they got before
dying) rides alongside as a second, independent signal. **Why:** a metric that
reads "flat" for everyone is useless; the early-death signal is the same
primitive first_death_ledger uses, here trended over the progression — a
genuinely different question (improvement vs current rank).

## D9 — learning_curve: the team baseline (cancelling the progression-depth confounder)

**Question:** A player's late÷early ratio must be normalised against the team
(so "the boss got to a harder phase" doesn't read as one player stalling).
Median of per-player ratios, or a pooled aggregate?

**Decision:** **Aggregate** — pooled `Σ(lateRate·latePulls) ÷ Σ(earlyRate·
earlyPulls)`. The median-of-ratios degenerates to 0 the moment a couple of
players fully stop dying (ratio→0), which then explodes everyone else's
relative ratio into mass false flags (caught when the first test failed
exactly this way). **Why:** the pooled rate is volume-weighted and finite even
when several players hit zero — robust where the median is brittle.

## D10 / D12 — learning_curve: making the coaching flag fair

**Decisions (data- + review-driven):** (1) The flag requires BOTH "improved
meaningfully less than the team" (relativeRatio ≥ 1.3) AND "still at/above the
team's current early-death rate" — without the second clause, a player with a
low-but-flat rate gets flagged just because the rest improved past them (a
real false positive seen in the data: Rhystank 0.06→0.07). (2) The flag always
renders ALONGSIDE its early→late evidence, never as a bare ranked list (the
research's hard rule). (3) Added a duty-context caveat in the copy: the signal
is deaths-based with NO role context, so an assigned soak/kite/tank death reads
like a mistake — sanity-check role before coaching (duty tags are a future G1
dependency that doesn't exist yet).

## D11 — learning_curve: avoidable-damage enrichment — ship what's verifiable

**Question:** The research frames learning_curve as a fusion whose richest
signal is avoidable-damage (near-misses deaths miss). Two sources, both the
report's UNVERIFIED probes: the addon `C_DamageMeter` (A.7 #16) and a WCL
`table(DamageTaken, abilityID)` filter (A.7 #14). Which to build, given I can't
run an in-game probe?

**Options:**
- (a) Build the addon `C_DamageMeter` path. The report's primary source, but
  the API is "new and moving" (changed signatures in 12.0.1) and UNVERIFIED —
  building it blind risks shipping code that silently produces WRONG data.
- (b) Build the WCL `DamageTaken` path. I PROBED it live (2026-06-14) — it
  WORKS (resolves A.7 #14), pairing with the deaths layer's killing abilities
  as an auto-curated avoidable-mechanic list. But it needs net-new per-bucket
  GRS ingestion + a model.
- (c) Ship the deaths-based core (verifiable now) with the avoidable-damage
  PROCESSING capability in place (the lib + widget slot light up when fed),
  and document (b) as the verified next step.

**Decision: (c).** The deaths-based early-death-decay core is complete,
validated against real data, and genuinely useful on its own. The pipeline IS
able to process avoidable-damage (the `avoidableDamage` per-pull slot →
`earlyAvoidable`/`lateAvoidable` → the widget's ready column) — it just needs a
feed. I will NOT ship unverifiable `C_DamageMeter` code (a) — feature-detected
or not, an API I can't test could produce confidently-wrong coaching data,
which is worse than no data. The verified WCL `DamageTaken` feed (b) is the
documented, probed, recommended follow-up. **Why:** shipping a verified,
meaningful widget + an honest ready-slot beats rushing an unverifiable feed at
the end of a long build; "able to add enriching data + processed accordingly"
is satisfied by the end-to-end processing slot, with the verified source one
focused step away.

---

## Summary — "Create these widgets" task complete

All six requested widgets shipped (professions, first_death_ledger,
attendance_ledger, tonight_ready was folded earlier, learning_curve, plus the
Missing-Fixes lightbox), each one tested before moving on. The three that the
research flagged as blocked on a data source were unblocked here:

| Widget | Data source built | Validated against | Key deliberations |
|---|---|---|---|
| first_death_ledger | WCL **deaths layer** (`WclFightDeath`) inside GRS + self-healing backfill | real Eclipse logs (14.7k deaths, procedure via authed caller) | D3 (observed-pulls denominator), D4 (`deathsFetchedAt` anti-re-fetch) |
| attendance_ledger | addon **raidObserver** presence (`RaidNightObservation`, SCHEMA 3/v1.2.0) + calendar signups | synthetic pipeline (scoring exact) + 11 unit tests | D5 (observed-presence only, in-game calendar deferred), D6 (cluster→union nights), D7 (clock-clamp, name+realm) |
| learning_curve | WCL **deaths-trend** (early-death-rate decay, team-relative) | real Eclipse logs (discriminates improving/regressing) + 7 unit tests | D8 (early-death not raw), D9 (aggregate baseline), D10/D12 (fair flag + duty caveat), D11 (verifiable core, avoidable-damage ready-slot) |

Every widget: a pure-logic lib + vitest, a tRPC procedure, the component +
registration, two independent worker reviews (all findings addressed), and a
green gate (tsc/eslint/vitest/prod-build) before deploy. The companion app was
NOT touched — all new in-game collection rides the existing `RTS1:` export.
The one deliberate non-build: the addon `C_DamageMeter` avoidable-damage path
(unverifiable in-game); its verified WCL `DamageTaken` replacement is probed,
documented, and the processing slot is wired for it.

---

## Backlog drops (2026-06-14, user request)

- **stat_priority_audit** — DROPPED from the backlog. Never implemented (no
  WIDGET_TYPES / registry / component entry — research-doc prose only:
  widget-research.md idea #8). No code change needed.
- **reset_board** — DROPPED from the backlog. Never implemented (research-doc
  spec only: widget-and-preparedness-research.md "W13"). No code change needed.

Both were unbuilt backlog ideas; this records the decision to retire them.
