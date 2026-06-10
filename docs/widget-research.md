# Raid-leader widget research

Distilled from the reference Google Sheet (Eclipse Midnight / "With the Sun"
roster spreadsheet) plus standard raid-leader workflows on
raider.io / warcraftlogs / Mr. Mythical / WoWAnalyzer.

## What the reference spreadsheet tracks (per column)

- **Roster identity**: rank, character name, main/alt flag, class, faction
- **Gear summary**: average item level, equipped vs missing pieces,
  per-slot item level (head/chest/shoulder/legs/feet, hands, waist, wrists,
  neck, back, ring1, ring2, trinket1, trinket2, mainhand, offhand)
- **Audit flags**: missing enchants count, missing gems count, sockets
  filled vs available
- **Tier set**: pieces equipped, set IDs
- **Mythic+**: current-season rating, runs completed this week, highest
  key this week
- **Vault**: how many slots are unlocked this week (M+ has up to 8 dungeon
  slots, raid up to 3, world quests/PvP separate)
- **Raid progression**: per-boss kill matrix across difficulties (N/H/M),
  best percentile per boss
- **Professions**: primary + secondary, skill rank
- **Recent activity**: weekly quest completion, vault selections this week
- **Notes / weekly check-ins**: free-text annotations from officers

## What we already snapshot

| Domain                    | Source(s)         | Already widgeted? |
| ------------------------- | ----------------- | ----------------- |
| iLvL, level, spec         | Blizzard, RIO     | yes               |
| Equipment + missing fixes | Blizzard          | yes (gear audit)  |
| Tier set pieces / IDs     | Blizzard          | yes               |
| M+ rating + runs this wk  | Blizzard, RIO     | yes (ladder)      |
| Vault slot eligibility    | Blizzard, derived | yes               |
| Raid completion           | Blizzard, WCL     | yes               |
| Best WCL parses           | WCL               | yes               |
| Roster freshness          | derived           | yes               |

## What we don't yet snapshot (deferred — needs ingestion work)

- Professions (Blizzard endpoint exists but we don't fetch it)
- Per-pull raid attendance (WCL fight participation, multi-query)
- Socket count by slot (parseable from equipment if we extend the schema)
- Time-on-objective / damage taken per fight (WCL detail)

## New widgets that consume existing snapshots

1. **Class & role composition** — count by class + spec; bar chart or
   table. Useful for "do we have enough healers / interrupts?".
2. **iLvL distribution histogram** — buckets of 3 ilvl, see spread across
   team and identify outliers.
3. **Talent-loadout viewer** — `CharacterSnapshot.activeTalentLoadout`
   already captured; expose as a table of "name → talent code".
4. **Vault detail card** — show all three reward rows (M+, raid, PvP)
   and how many slots each char has unlocked this week.
5. **Missing-fix drill-down** — flat list of every (character, slot)
   that lacks an enchant or gem, sorted by ilvl descending. Officer-
   actionable.
6. **Parses by boss** — heatmap of best-percentile per (character, boss)
   for the current raid tier. Drill-in to a specific fight.
7. **Recent kills** — new boss kills (per character, raid difficulty)
   in the last 7 days. Pulls from `RaidSnapshot` diff.
8. **Stat priority audit** — secondary stats (crit/haste/mastery/vers)
   vs spec recommendation. (Recommendation table is class+spec lookup;
   we'd hardcode the meta priorities.)

## Tabbed-dashboard motivation

A single page covering 8+ widgets is unreadable. Standard raid-leader
workflow: a tab per concern.

- **Tab: Readiness** — iLvL roster, gear audit drill-down, missing fixes
- **Tab: Progression** — raid completion, recent kills, parses heatmap
- **Tab: M+** — ladder, vault, runs-this-week
- **Tab: Composition** — class & role, talent loadouts, single-character
  deep view
