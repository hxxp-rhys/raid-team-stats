import { z } from "zod";

/**
 * GraphQL queries we currently exercise. Each is paired with a zod schema
 * for `data` so callers stay typed at the boundary.
 */

export const CHARACTER_ZONE_RANKINGS_QUERY = /* GraphQL */ `
  query CharacterZoneRankings(
    $name: String!
    $server: String!
    $region: String!
    $zoneID: Int!
    $metric: CharacterPageRankingMetricType
    $difficulty: Int
  ) {
    characterData {
      character(name: $name, serverSlug: $server, serverRegion: $region) {
        id
        name
        zoneRankings(zoneID: $zoneID, metric: $metric, difficulty: $difficulty)
      }
    }
  }
`;

export const characterZoneRankingsResponseSchema = z
  .object({
    characterData: z
      .object({
        character: z
          .object({
            id: z.number().int().nullable().optional(),
            name: z.string().optional(),
            // `zoneRankings` is a JSON scalar in WCL's schema — passthrough.
            zoneRankings: z.unknown().nullable().optional(),
          })
          .nullable()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type CharacterZoneRankingsResponse = z.infer<
  typeof characterZoneRankingsResponseSchema
>;

/**
 * Flat list of every WCL raid/zone (`worldData.zones`, the same shape
 * scripts/wcl-smoke.ts uses). Used to auto-resolve the CURRENT raid tier:
 * the highest-id zone that is NOT frozen and NOT a PTR/M+/Delve zone.
 * (The earlier `worldData.expansions[].zones` variant was unreliable —
 * WCL lumps Classic seasonal expansions in with large ids.)
 */
export const WCL_RAID_ZONES_QUERY = /* GraphQL */ `
  query WclRaidZones {
    worldData {
      zones {
        id
        name
        frozen
      }
    }
  }
`;

export const wclRaidZonesResponseSchema = z
  .object({
    worldData: z
      .object({
        zones: z
          .array(
            z
              .object({
                id: z.number().int(),
                name: z.string().optional(),
                frozen: z.boolean().nullable().optional(),
              })
              .passthrough(),
          )
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

/**
 * Encounters (bosses) for a single zone — used to resolve the current
 * raid tier's boss list so we can request per-encounter rankings.
 */
export const ZONE_ENCOUNTERS_QUERY = /* GraphQL */ `
  query WclZoneEncounters($zoneID: Int!) {
    worldData {
      zone(id: $zoneID) {
        id
        name
        encounters {
          id
          name
        }
      }
    }
  }
`;

export const wclZoneEncountersResponseSchema = z
  .object({
    worldData: z
      .object({
        zone: z
          .object({
            id: z.number().int(),
            name: z.string().optional(),
            encounters: z
              .array(
                z
                  .object({ id: z.number().int(), name: z.string().optional() })
                  .passthrough(),
              )
              .nullable()
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

/**
 * Builds a single batched query that asks for `encounterRankings` (which —
 * unlike `zoneRankings` — exposes individual `ranks[]` each with a
 * `startTime`/`report`) for every current-tier encounter at one difficulty.
 * Aliased per encounter (`e<id>`) so it's one HTTP request per character.
 *
 * `encounterRankings` is a JSON scalar in WCL's schema → passthrough.
 */
export const buildCharacterEncounterRankingsQuery = (
  encounterIds: number[],
): string => {
  // NOTE the enum nuance: encounterRankings takes CharacterRankingMetricType
  // while zoneRankings takes CharacterPageRankingMetricType — they are
  // different GraphQL enums with overlapping members (dps/hps/tankhps).
  const fields = encounterIds
    .map(
      (id) =>
        `e${id}: encounterRankings(encounterID: ${id}, difficulty: $difficulty, metric: $metric)`,
    )
    .join("\n        ");
  return /* GraphQL */ `
    query CharEncounterRankings(
      $name: String!
      $server: String!
      $region: String!
      $difficulty: Int
      $metric: CharacterRankingMetricType
    ) {
      characterData {
        character(name: $name, serverSlug: $server, serverRegion: $region) {
          id
          name
          ${fields}
        }
      }
    }
  `;
};

export const characterEncounterRankingsResponseSchema = z
  .object({
    characterData: z
      .object({
        character: z
          .record(z.string(), z.unknown())
          .nullable()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * GRS discovery — one log SOURCE's recent public reports for one zone,
 * keyed by WCL guild id (`guildID` is a verified introspected arg of
 * reportData.reports, alongside guildTagID/userID for future source
 * kinds). All sources are numeric ids after resolution — the guild
 * default resolves once via GUILD_ID_LOOKUP_QUERY and per-team overrides
 * are entered as ids/URLs. `startTime`/`endTime` are epoch ms floats.
 */
export const GUILD_REPORTS_QUERY = /* GraphQL */ `
  query GuildReports(
    $guildID: Int!
    $zoneID: Int
    $startTime: Float
    $limit: Int
  ) {
    reportData {
      reports(
        guildID: $guildID
        zoneID: $zoneID
        startTime: $startTime
        limit: $limit
      ) {
        data {
          code
          title
          startTime
          endTime
          revision
          zone {
            id
          }
        }
      }
    }
  }
`;

/**
 * Resolve a guild's WCL guild id from its Blizzard identity — the lazy
 * one-time resolution of the DEFAULT log source for a guild's teams.
 */
export const GUILD_ID_LOOKUP_QUERY = /* GraphQL */ `
  query GuildIdLookup(
    $name: String!
    $serverSlug: String!
    $serverRegion: String!
  ) {
    guildData {
      guild(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
        id
        name
      }
    }
  }
`;

/**
 * Probe a WCL guild id — validates a user-entered per-team source and
 * echoes the resolved name/server back for confirmation before saving.
 */
export const GUILD_BY_ID_QUERY = /* GraphQL */ `
  query GuildById($id: Int!) {
    guildData {
      guild(id: $id) {
        id
        name
        server {
          name
          slug
        }
      }
    }
  }
`;

export const guildLookupResponseSchema = z
  .object({
    guildData: z
      .object({
        guild: z
          .object({
            id: z.number().int(),
            name: z.string().optional(),
            server: z
              .object({
                name: z.string().nullable().optional(),
                slug: z.string().nullable().optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type GuildLookupResponse = z.infer<typeof guildLookupResponseSchema>;

export const guildReportsResponseSchema = z
  .object({
    reportData: z
      .object({
        reports: z
          .object({
            data: z
              .array(
                z
                  .object({
                    code: z.string(),
                    title: z.string().nullable().optional(),
                    startTime: z.number(),
                    endTime: z.number(),
                    revision: z.number().int(),
                    zone: z
                      .object({ id: z.number().int() })
                      .passthrough()
                      .nullable()
                      .optional(),
                  })
                  .passthrough()
                  .nullable(),
              )
              .nullable()
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type GuildReportsResponse = z.infer<typeof guildReportsResponseSchema>;

/**
 * GRS detail — one report's encounter pulls + player actor table. Every
 * requested field verified by live introspection + live probe 2026-06-11:
 * fight startTime/endTime are REPORT-RELATIVE ms (absolute = report
 * startTime + offset); keystoneLevel is null on raid fights (non-null = M+,
 * dropped at ingest); encounterID 0 = trash (excluded by killType but
 * filtered defensively anyway).
 */
export const REPORT_FIGHTS_QUERY = /* GraphQL */ `
  query ReportFights($code: String!) {
    reportData {
      report(code: $code) {
        code
        startTime
        endTime
        revision
        zone {
          id
        }
        fights(killType: Encounters) {
          id
          encounterID
          difficulty
          kill
          size
          bossPercentage
          fightPercentage
          lastPhase
          lastPhaseIsIntermission
          startTime
          endTime
          friendlyPlayers
          keystoneLevel
        }
        masterData {
          actors(type: "Player") {
            id
            name
            server
            subType
          }
        }
      }
    }
  }
`;

export const reportFightsResponseSchema = z
  .object({
    reportData: z
      .object({
        report: z
          .object({
            code: z.string(),
            startTime: z.number(),
            endTime: z.number(),
            // Required to match the discovery schema: a divergent (defaulted)
            // revision would never equal discovery's and the report would
            // re-fetch every run forever. Live data always carries it.
            revision: z.number().int(),
            zone: z
              .object({ id: z.number().int() })
              .passthrough()
              .nullable()
              .optional(),
            fights: z
              .array(
                z
                  .object({
                    id: z.number().int(),
                    encounterID: z.number().int(),
                    difficulty: z.number().int().nullable().optional(),
                    kill: z.boolean().nullable().optional(),
                    size: z.number().int().nullable().optional(),
                    bossPercentage: z.number().nullable().optional(),
                    fightPercentage: z.number().nullable().optional(),
                    lastPhase: z.number().int().nullable().optional(),
                    lastPhaseIsIntermission: z
                      .boolean()
                      .nullable()
                      .optional(),
                    startTime: z.number(),
                    endTime: z.number(),
                    friendlyPlayers: z
                      .array(z.number().int().nullable())
                      .nullable()
                      .optional(),
                    keystoneLevel: z.number().int().nullable().optional(),
                  })
                  .passthrough()
                  .nullable(),
              )
              .nullable()
              .optional(),
            masterData: z
              .object({
                actors: z
                  .array(
                    z
                      .object({
                        id: z.number().int(),
                        name: z.string(),
                        server: z.string().nullable().optional(),
                        subType: z.string().nullable().optional(),
                      })
                      .passthrough()
                      .nullable(),
                  )
                  .nullable()
                  .optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type ReportFightsResponse = z.infer<typeof reportFightsResponseSchema>;

/**
 * GRS deaths layer — per-fight death EVENTS for the current report. The
 * death-order spine of the first_death_ledger widget. Shape verified live
 * 2026-06-14 against a real Eclipse report: each event is
 *   { timestamp(report-relative ms), type:"death", sourceID:-1,
 *     targetID(=who died, report-local actor id), abilityGameID:0,
 *     fight(=fightId), killerID(=source of the killing blow),
 *     killingAbilityGameID }
 * NOTE the killer attribution is `killerID` + `killingAbilityGameID`, NOT
 * `abilityGameID` (which is 0 on death rows). `events` is a `JSON` scalar
 * (ReportEventPaginator → `data` + `nextPageTimestamp`) and is TIME-CURSOR
 * paginated: pass the previous page's `nextPageTimestamp` back as
 * `$startTime` until it comes back null. Scope to wipe/kill fightIDs.
 */
export const REPORT_DEATHS_QUERY = /* GraphQL */ `
  query ReportDeaths($code: String!, $fightIDs: [Int], $startTime: Float) {
    reportData {
      report(code: $code) {
        events(
          dataType: Deaths
          killType: Encounters
          fightIDs: $fightIDs
          startTime: $startTime
          limit: 10000
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

export const reportDeathsResponseSchema = z
  .object({
    reportData: z
      .object({
        report: z
          .object({
            events: z
              .object({
                // JSON scalar — array of death-event objects.
                data: z.unknown().nullable().optional(),
                nextPageTimestamp: z.number().nullable().optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type ReportDeathsResponse = z.infer<typeof reportDeathsResponseSchema>;

/**
 * GRS deaths layer — the per-death overkill / killing-blow DRILL-DOWN. A
 * single `table(dataType: Deaths)` JSON blob per report (not cursor-paged).
 * Verified-live entry shape:
 *   data.entries[].{ id(=actor), name, timestamp, fight, overkill,
 *                    killingBlow{ name, guid, abilityIcon }, deathWindow }
 * `overkill` (how far the killing blow exceeded the target's HP) is the only
 * place overkill is exposed — it is NOT on the raw events. Used opportunistic-
 * ally to enrich the events spine; never blocks ingestion if it fails.
 */
export const REPORT_DEATHS_TABLE_QUERY = /* GraphQL */ `
  query ReportDeathsTable($code: String!, $fightIDs: [Int]) {
    reportData {
      report(code: $code) {
        table(dataType: Deaths, killType: Encounters, fightIDs: $fightIDs)
      }
    }
  }
`;

export const reportDeathsTableResponseSchema = z
  .object({
    reportData: z
      .object({
        report: z
          .object({
            // JSON scalar — { data: { entries: [...] } }.
            table: z.unknown().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type ReportDeathsTableResponse = z.infer<
  typeof reportDeathsTableResponseSchema
>;

/**
 * learning_curve avoidable-damage enrichment — per-player damage TAKEN from
 * ONE ability, summed across the passed `fightIDs`. VERIFIED LIVE 2026-06-14.
 * `data.entries[]` = `{ id(=actor), name, type(=class), total, … }`.
 * `abilityID` is a **Float** var. Pair with the deaths layer's killing
 * abilities (auto-curated avoidable mechanics) per early/late wipe bucket.
 */
export const REPORT_DAMAGE_TAKEN_QUERY = /* GraphQL */ `
  query ReportDamageTaken($code: String!, $fightIDs: [Int], $abilityID: Float) {
    reportData {
      report(code: $code) {
        table(
          dataType: DamageTaken
          killType: Encounters
          fightIDs: $fightIDs
          abilityID: $abilityID
        )
      }
    }
  }
`;

export const reportDamageTakenResponseSchema = z
  .object({
    reportData: z
      .object({
        report: z
          .object({
            // JSON scalar — { data: { entries: [...] } }.
            table: z.unknown().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type ReportDamageTakenResponse = z.infer<
  typeof reportDamageTakenResponseSchema
>;

/**
 * brez_economy — combat-resurrection CASTS for the current report. VERIFIED
 * LIVE 2026-06-14: there is NO `Resurrects` dataType — combat-rez is a Cast.
 * Filter by ability id (NAME matching returns nothing) to the verified rez
 * spells: 20484 Rebirth (Druid), 20707 Soulstone (Warlock), 61999 Raise Ally
 * (DK), 391054 Intercession (Paladin). Only `type:"cast"` rows are LANDED
 * rezzes (begincasts can be cancelled). Event = `{ timestamp, type, sourceID
 * (=rezzer), targetID (=rezzed), abilityGameID, fight }`. Same paginated
 * ReportEventPaginator shape as the deaths events (reuse that schema). Extend
 * the id list when a new class/item rez appears.
 */
export const REZ_ABILITY_IDS = [20484, 20707, 61999, 391054] as const;
export const REZ_FILTER_EXPRESSION = `type = "cast" and ability.id in (${REZ_ABILITY_IDS.join(", ")})`;
export const REPORT_REZZES_QUERY = /* GraphQL */ `
  query ReportRezzes(
    $code: String!
    $fightIDs: [Int]
    $startTime: Float
    $filter: String
  ) {
    reportData {
      report(code: $code) {
        events(
          dataType: Casts
          killType: Encounters
          fightIDs: $fightIDs
          startTime: $startTime
          filterExpression: $filter
          limit: 10000
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

/**
 * cooldown_usage — personal-defensive BUFF windows for the current report.
 * VERIFIED LIVE 2026-06-15 against Eclipse report `DFcmRxYdvBC7ZNfA`. Filtered
 * to the defensive allowlist (src/lib/defensive-cooldowns.ts, ~36 ids) so a
 * whole raid night is ~500 events / ~8 pts rather than 10k+/fight unfiltered.
 *
 * NO `type =` clause — we want BOTH `applybuff` and `removebuff` to reconstruct
 * each `[start,end]` active window. Event =
 *   { timestamp(report-relative ms), type:"applybuff"|"removebuff",
 *     sourceID(=caster), targetID(=buffed actor), abilityGameID, fight,
 *     absorb?(remaining shield for AMS etc.) }
 * For a PERSONAL defensive sourceID === targetID. Time-cursor paginated
 * (`nextPageTimestamp`) exactly like the deaths events — reuse
 * `reportDeathsResponseSchema`. Always pass the real wipe fightIDs (`[]`
 * returns 0 events, not "all").
 */
export const REPORT_DEFENSIVE_BUFFS_QUERY = /* GraphQL */ `
  query ReportDefensiveBuffs(
    $code: String!
    $fightIDs: [Int]
    $startTime: Float
    $filter: String
  ) {
    reportData {
      report(code: $code) {
        events(
          dataType: Buffs
          killType: Encounters
          fightIDs: $fightIDs
          startTime: $startTime
          filterExpression: $filter
          limit: 10000
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

/**
 * cooldown_usage — personal-defensive CASTS for the current report (the
 * "cast a defensive shortly before dying" secondary signal + the v1.1
 * available-but-unused spine). VERIFIED LIVE 2026-06-15. `type = "cast"` only
 * (landed casts; begincasts can be cancelled). Event =
 *   { timestamp, type:"cast", sourceID(=caster), targetID(-1 self-cast),
 *     abilityGameID, fight }. Same paginated shape — reuse the deaths schema.
 */
export const REPORT_DEFENSIVE_CASTS_QUERY = /* GraphQL */ `
  query ReportDefensiveCasts(
    $code: String!
    $fightIDs: [Int]
    $startTime: Float
    $filter: String
  ) {
    reportData {
      report(code: $code) {
        events(
          dataType: Casts
          killType: Encounters
          fightIDs: $fightIDs
          startTime: $startTime
          filterExpression: $filter
          limit: 10000
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

// ── On-demand DEATH CONTEXT (cooldown_usage death lightbox) ─────────────────
// A small windowed fetch around one death, fired only when a raid leader clicks
// a death. VERIFIED LIVE 2026-06-15 against Eclipse report WhwV1qZjym67xTLA.
//
// CRITICAL WCL QUIRK (re-verified live 2026-06-15, report WhwV1qZjym67xTLA): for
// dataType: DamageTaken the actor FILTER is inverted — `sourceID: <playerId>`
// selects the damage that player TOOK (the player is the "source" of the
// taken-damage view), while the returned event rows still label source=attacker
// (boss) / target=victim (player). The earlier `targetID + hostilityType:
// Enemies` form was WRONG: it returned the player's OUTGOING damage to enemies
// (Enemies = damage taken *by enemies*), so the timeline showed the player
// hitting the boss instead of the boss hitting the player. `targetID` alone
// returns 0. Each row carries a `.`-delimited `buffs` string = every buff id
// active ON THE VICTIM at that instant, so the defensives up at the fatal hit
// are read straight off the killing-blow row.

/** Boss damage the player took in the window (incoming-hit timeline). */
export const DEATH_DAMAGE_TAKEN_QUERY = /* GraphQL */ `
  query DeathDamageTaken(
    $code: String!
    $fightIDs: [Int]
    $playerID: Int
    $startTime: Float
    $endTime: Float
  ) {
    reportData {
      report(code: $code) {
        events(
          dataType: DamageTaken
          hostilityType: Friendlies
          fightIDs: $fightIDs
          sourceID: $playerID
          startTime: $startTime
          endTime: $endTime
          limit: 3000
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

/** Per-ability damage-taken breakdown for the window → ability id→name map. */
export const DEATH_DAMAGE_TABLE_QUERY = /* GraphQL */ `
  query DeathDamageTable(
    $code: String!
    $fightIDs: [Int]
    $startTime: Float
    $endTime: Float
  ) {
    reportData {
      report(code: $code) {
        table(
          dataType: DamageTaken
          hostilityType: Enemies
          fightIDs: $fightIDs
          startTime: $startTime
          endTime: $endTime
        )
      }
    }
  }
`;

/** The dying player's own casts in the window (what they pressed / mid-cast). */
export const DEATH_PLAYER_CASTS_QUERY = /* GraphQL */ `
  query DeathPlayerCasts(
    $code: String!
    $fightIDs: [Int]
    $sourceID: Int
    $startTime: Float
    $endTime: Float
  ) {
    reportData {
      report(code: $code) {
        events(
          dataType: Casts
          fightIDs: $fightIDs
          sourceID: $sourceID
          startTime: $startTime
          endTime: $endTime
          limit: 1000
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

/** Healing + absorbs the player received in the window (support / topped?). */
export const DEATH_HEALING_TAKEN_QUERY = /* GraphQL */ `
  query DeathHealingTaken(
    $code: String!
    $fightIDs: [Int]
    $targetID: Int
    $startTime: Float
    $endTime: Float
  ) {
    reportData {
      report(code: $code) {
        events(
          dataType: Healing
          fightIDs: $fightIDs
          targetID: $targetID
          startTime: $startTime
          endTime: $endTime
          limit: 2000
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

/**
 * Report master-data dictionary: the canonical ability id→name + actor id→name
 * maps for the WHOLE report. Used by deathContext to resolve every ability in
 * the death window (the windowed DamageTaken table only names abilities that
 * dealt damage, leaving gaps). Per-report + immutable once frozen → cached.
 */
export const REPORT_MASTERDATA_QUERY = /* GraphQL */ `
  query ReportMasterData($code: String!) {
    reportData {
      report(code: $code) {
        masterData {
          abilities {
            gameID
            name
          }
          actors {
            id
            name
            type
            subType
          }
        }
      }
    }
  }
`;

export const reportMasterDataResponseSchema = z
  .object({
    reportData: z
      .object({
        report: z
          .object({
            masterData: z
              .object({
                abilities: z
                  .array(
                    z
                      .object({
                        gameID: z.number().nullable().optional(),
                        name: z.string().nullable().optional(),
                      })
                      .passthrough(),
                  )
                  .nullable()
                  .optional(),
                actors: z
                  .array(
                    z
                      .object({
                        id: z.number().nullable().optional(),
                        name: z.string().nullable().optional(),
                        type: z.string().nullable().optional(),
                        subType: z.string().nullable().optional(),
                      })
                      .passthrough(),
                  )
                  .nullable()
                  .optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type ReportMasterDataResponse = z.infer<
  typeof reportMasterDataResponseSchema
>;
