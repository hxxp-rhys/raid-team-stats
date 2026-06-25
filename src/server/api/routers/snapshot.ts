import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { Prisma } from "@/generated/prisma/client";
import {
  router,
  publicProcedure,
  assertTeamReadAccess,
} from "@/server/api/trpc";
import {
  absenceSignal,
  activitySignal,
  closedWeekStarts,
  decayFlag,
  loginSignal,
  medianOf,
  mplusSignal,
  riskScore,
  watchlisted,
  weekStartUtc,
} from "@/lib/engagement-pulse";
import {
  extractKillDetail,
  extractKillRanks,
  roleOf,
  stdevOf,
  theilSen,
} from "@/lib/parse-consistency";
import {
  aggregateLedger,
  type LedgerDeath,
  type LedgerEncounter,
  type LedgerFight,
} from "@/lib/first-death-ledger";
import {
  aggregateCooldownUsage,
  type CooldownDeathInput,
  type CooldownDifficultyAgg,
} from "@/lib/cooldown-usage";
import {
  computeAttendance,
  mergeObservers,
  type NightState,
} from "@/lib/attendance-ledger";
import {
  computeLearning,
  type LearnPull,
  type MemberLearning,
} from "@/lib/learning-curve";
import {
  extractCurrentTierKnown,
  groupKnownAlphabetical,
  groupKnownLikeInGame,
} from "@/lib/widgets/professions-logic";
import { isAddonFresh, resolveField } from "@/lib/source-resolver";
import {
  isOutdated,
  LATEST_COMPANION_VERSION,
  LATEST_ADDON_VERSION,
} from "@/lib/companion-release";
import { warcraftLogsClient } from "@/server/ingestion/warcraftlogs/client";
import {
  DEATH_DAMAGE_TAKEN_QUERY,
  DEATH_PLAYER_CASTS_QUERY,
  DEATH_HEALING_TAKEN_QUERY,
  REPORT_MASTERDATA_QUERY,
  reportDeathsResponseSchema,
  reportMasterDataResponseSchema,
} from "@/server/ingestion/warcraftlogs/queries";
import {
  buildDeathContext,
  parseCastWindow,
  parseDamageTakenEvents,
  parseHealWindow,
  type DeathContextResult,
} from "@/lib/death-context";
import { redis } from "@/lib/redis";
import { computeGearAudit } from "@/server/ingestion/gear-audit";
import { getProfessionCategories } from "@/server/professions/recipe-categories";
import {
  addonPayloadSchema,
  deriveVaultDetail,
  normalizeKey,
} from "@/server/ingestion/addon/payload";

/**
 * Read-only access to the per-domain snapshot rows. Authorization rides on
 * raid-team membership — anyone who can see the team can read the snapshots
 * of its active members.
 */

/**
 * Compact, client-safe view-model of the schema-2 addon payload sections
 * (the API-blind data: full vault, held keystone, weekly lockouts, upgrade
 * currencies, consumables, delves, talent build string). Raw item links /
 * the full payload are intentionally NOT sent to the client.
 */
export type AddonView = {
  collectedAt: Date | null;
  addonVersion: string | null;
  vault: ReturnType<typeof deriveVaultDetail>;
  keystone: { mapName: string | null; level: number | null } | null;
  // THIS reset's completed M+ runs (repeats included), highest level first.
  // The authoritative weekly run list straight from the addon — Blizzard/RIO
  // only expose the deduped best-per-dungeon. `mapName` is null today; a
  // future addon release adds it, so the view is designed for both.
  weeklyRuns: Array<{
    mapId: number | null;
    level: number | null;
    mapName: string | null;
  }>;
  // One entry per raid this reset, with the four standard difficulties
  // (LFR / Normal / Heroic / Mythic) as fixed columns — `null` where the
  // member has no lockout at that difficulty.
  lockouts: Array<{
    raid: string;
    diffs: Array<{
      tier: "LFR" | "Normal" | "Heroic" | "Mythic";
      prog: { killed: number; total: number; extended: boolean } | null;
    }>;
  }>;
  currencies: Array<{
    name: string;
    quantity: number | null;
  }>;
  consumables: {
    flask: number;
    potion: number;
    food: number;
    weaponEnh: number;
    other: number;
    /** Per-bucket itemized list (name + count) for hover detail. */
    breakdown: Record<
      "flask" | "potion" | "food" | "weaponEnh" | "other",
      Array<{ name: string; count: number }>
    >;
  };
  delves: {
    season: number | null;
    tier: number | null;
    companion: number | null;
  } | null;
  talents: { importString: string } | null;
};

const CURRENCY_KEYWORDS = [
  "catalyst",
  "crest",
  "valorstone",
  "coffer",
  "spark",
  "mettle",
  "kej",
];

function buildAddonView(
  raw: unknown,
  collectedAt: Date | null,
  addonVersion: string | null,
): AddonView | null {
  const parsed = addonPayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;

  const ks = p.mythicPlus?.ownedKeystone ?? null;
  const keystone = ks
    ? { mapName: ks.mapName ?? null, level: ks.level ?? null }
    : null;

  // THIS reset's completed M+ runs. `mapId`/`mapName` ride along via the
  // schema's passthrough (not in the typed shape); `mapName` is null until a
  // future addon release supplies it. Drop the explicitly-incomplete runs,
  // then sort by key level descending so the highest keys lead.
  const weeklyRuns = (p.mythicPlus?.weeklyRuns ?? [])
    .filter((run) => run.completed !== false)
    .map((run) => {
      const r = run as { mapId?: unknown; mapName?: unknown };
      return {
        mapId: typeof r.mapId === "number" ? r.mapId : null,
        level: typeof run.level === "number" ? run.level : null,
        mapName: typeof r.mapName === "string" ? r.mapName : null,
      };
    })
    .sort((a, b) => (b.level ?? -1) - (a.level ?? -1));

  // Group raid lockouts by raid, with the four standard difficulties as
  // fixed slots. Blizzard difficultyIds: 17=LFR, 14=Normal, 15=Heroic,
  // 16=Mythic (fall back to the localized name when an id is missing).
  type DiffKey = "LFR" | "Normal" | "Heroic" | "Mythic";
  const DIFF_ORDER: DiffKey[] = ["LFR", "Normal", "Heroic", "Mythic"];
  const DIFF_BY_ID: Record<number, DiffKey> = {
    17: "LFR",
    14: "Normal",
    15: "Heroic",
    16: "Mythic",
  };
  const diffKey = (l: {
    difficultyId?: number | null;
    difficulty?: string | null;
  }): DiffKey | null => {
    if (typeof l.difficultyId === "number" && DIFF_BY_ID[l.difficultyId]) {
      return DIFF_BY_ID[l.difficultyId];
    }
    const d = (l.difficulty ?? "").toLowerCase();
    if (d.includes("mythic")) return "Mythic";
    if (d.includes("heroic")) return "Heroic";
    if (d.includes("normal")) return "Normal";
    if (d.includes("raid finder") || d.includes("looking for raid") || d === "lfr")
      return "LFR";
    return null;
  };
  type DiffProg = { killed: number; total: number; extended: boolean };
  const raidMap = new Map<string, Partial<Record<DiffKey, DiffProg>>>();
  for (const l of p.lockouts ?? []) {
    if (l.isRaid !== true) continue;
    // Only an ACTIVE weekly reset counts. The addon emits `resetSeconds`
    // (passthrough — not in the typed shape): the genuine current lockouts
    // carry a positive time-until-reset, while stale/expired saved-instance
    // rows (old raids, duplicate difficulty rows, world bosses) all report
    // resetSeconds 0. Coerce with Number() — the field may arrive as a string.
    const resetSeconds = Number(
      (l as { resetSeconds?: unknown }).resetSeconds,
    );
    if (!(resetSeconds > 0)) continue;
    const k = diffKey(l);
    if (!k) continue;
    const raid = l.name ?? "?";
    const bosses = l.bosses ?? [];
    const total =
      bosses.length || (typeof l.encounters === "number" ? l.encounters : 0);
    const g = raidMap.get(raid) ?? {};
    g[k] = {
      killed: bosses.filter((b) => b.killed === true).length,
      total,
      extended: l.extended === true,
    };
    raidMap.set(raid, g);
  }
  const lockouts = [...raidMap.entries()]
    .map(([raid, byId]) => ({
      raid,
      diffs: DIFF_ORDER.map((tier) => ({ tier, prog: byId[tier] ?? null })),
    }))
    .sort(
      (a, b) =>
        Math.max(...b.diffs.map((d) => d.prog?.total ?? 0)) -
        Math.max(...a.diffs.map((d) => d.prog?.total ?? 0)),
    );

  const currencies = (p.currencies ?? [])
    .filter((c) => {
      const nm = c.name;
      return (
        typeof nm === "string" &&
        CURRENCY_KEYWORDS.some((k) => nm.toLowerCase().includes(k))
      );
    })
    .map((c) => ({
      name: c.name as string,
      quantity: c.quantity ?? null,
    }))
    .slice(0, 12);

  // WoW 12.0 reshuffled the Consumable item subclasses (raid prep items —
  // augment runes, weapon oils, potion cauldrons — all land in one "misc"
  // subclass), so the old sub-number → bucket map mostly fell to "other".
  // Classify by item NAME (the addon already sends it); fall back to the
  // subclass only when the name is inconclusive.
  const consumables = {
    flask: 0,
    potion: 0,
    food: 0,
    weaponEnh: 0,
    other: 0,
    breakdown: {
      flask: [] as Array<{ name: string; count: number }>,
      potion: [] as Array<{ name: string; count: number }>,
      food: [] as Array<{ name: string; count: number }>,
      weaponEnh: [] as Array<{ name: string; count: number }>,
      other: [] as Array<{ name: string; count: number }>,
    },
  };
  type Bucket = "flask" | "potion" | "food" | "weaponEnh" | "other";
  const classify = (
    name: string,
    sub: number | null | undefined,
  ): Bucket => {
    const n = name.toLowerCase();
    if (/\b(flask|phial)\b/.test(n)) return "flask";
    if (/\b(potion|cauldron|draught)\b/.test(n)) return "potion";
    if (
      /\b(feast|food|ration|banquet|stew|broth|meal)\b/.test(n) ||
      n.includes("celebration") ||
      n.includes("well fed")
    )
      return "food";
    if (/\b(oil|sharpening stone|weightstone|whetstone|wax)\b/.test(n))
      return "weaponEnh";
    if (sub === 3) return "flask";
    if (sub === 5) return "food";
    if (sub === 1) return "potion";
    if (sub === 6) return "weaponEnh";
    return "other";
  };
  for (const it of p.consumables?.items ?? []) {
    const n = it.count ?? 0;
    const name = typeof it.name === "string" ? it.name : "(unknown)";
    const b = classify(name, it.sub);
    consumables[b] += n;
    consumables.breakdown[b].push({ name, count: n });
  }
  for (const b of Object.keys(consumables.breakdown) as Bucket[]) {
    consumables.breakdown[b].sort((a, z) => z.count - a.count);
  }

  const dapi = (p.delves?.api ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" ? v : null;
  // addon ≥1.1.4 emits delves.tier (number) + delves.companion.level
  // (number). `tier` is the table's .tier — 0 unless a delve is active,
  // so surface that as "—". Legacy api.* kept for old payloads.
  const dRaw = p.delves as
    | { tier?: unknown; companion?: { level?: unknown } | null }
    | null
    | undefined;
  const tierRaw =
    num(dRaw?.tier) ??
    num(dapi.GetActiveDelveTier) ??
    num(dapi.GetCurrentDelveTier);
  const delvesObj = p.delves
    ? {
        season:
          num(dapi.GetCurrentDelvesSeasonNumber) ??
          num(dapi.GetDelvesSeasonNumber),
        tier: tierRaw && tierRaw > 0 ? tierRaw : null,
        companion: num(dRaw?.companion?.level),
      }
    : null;
  const delves =
    delvesObj &&
    (delvesObj.season != null ||
      delvesObj.tier != null ||
      delvesObj.companion != null)
      ? delvesObj
      : null;

  const talentsRaw = (p as { talents?: unknown }).talents;
  const importString =
    talentsRaw &&
    typeof talentsRaw === "object" &&
    typeof (talentsRaw as { importString?: unknown }).importString === "string"
      ? (talentsRaw as { importString: string }).importString
      : null;

  return {
    collectedAt,
    addonVersion,
    vault: deriveVaultDetail(p),
    keystone,
    weeklyRuns,
    lockouts,
    currencies,
    consumables,
    delves,
    talents: importString ? { importString } : null,
  };
}

export const snapshotRouter = router({
  /**
   * Most-recent snapshot of each kind for every active member of the given
   * raid team. Returns at most one row per (characterId, source) pair.
   */
  latestForTeam: publicProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      // Any team member or guild OWNER/OFFICER may read.
      await assertTeamReadAccess(ctx, input.raidTeamId);

      const memberships = await ctx.db.raidTeamMembership.findMany({
        where: { raidTeamId: input.raidTeamId, isActive: true },
        include: {
          character: {
            select: {
              id: true,
              userId: true,
              name: true,
              realmSlug: true,
              region: true,
              faction: true,
              classId: true,
              level: true,
              lastSyncedAt: true,
            },
          },
        },
      });

      const characterIds = memberships.map((m) => m.character.id);
      if (characterIds.length === 0) {
        return { members: [] as Array<{ character: never; latest: never }> };
      }

      // Companion (desktop uploader) install state is per-USER, joined to each
      // character via Character.userId — every character of the same user shows
      // the same install state. lastReceivedAt below stays genuinely
      // per-character (that character's own most-recent addon upload).
      const ownerUserIds = [...new Set(memberships.map((m) => m.character.userId))];
      const companionRows = await ctx.db.companionStatus.findMany({
        where: { userId: { in: ownerUserIds } },
        select: {
          userId: true,
          installed: true,
          lastSeenVersion: true,
          lastSeenAddonVersion: true,
        },
      });
      const companionByUser = new Map(
        companionRows.map((c) => [c.userId, c]),
      );
      // 7-day staleness threshold, computed SERVER-side.
      const COMPANION_STALE_MS = 7 * 24 * 60 * 60 * 1000;
      const companionNow = Date.now();

      // Pull the latest snapshot of each domain per character. Postgres
      // DISTINCT ON would be ideal but Prisma doesn't expose it; a per-
      // character batched query is acceptable for the 25-character raid scale.
      const latest = await Promise.all(
        characterIds.map((id) =>
          Promise.all([
            ctx.db.characterSnapshot.findFirst({
              where: { characterId: id, source: "BLIZZARD" },
              orderBy: { capturedAt: "desc" },
              select: {
                itemLevel: true,
                level: true,
                specName: true,
                loadoutText: true,
                capturedAt: true,
              },
            }),
            ctx.db.equipmentSnapshot.findFirst({
              where: { characterId: id, source: "BLIZZARD" },
              orderBy: { capturedAt: "desc" },
              select: {
                itemLevel: true,
                missingEnchantsCount: true,
                missingGemsCount: true,
                tierSetPiecesCount: true,
                tierSetIds: true,
                tierSlots: true,
                // Raw equipped items: used server-side only to derive the
                // per-slot missing-enchant/gem detail; not sent to clients.
                items: true,
                capturedAt: true,
              },
            }),
            ctx.db.mplusSnapshot.findFirst({
              where: { characterId: id, source: "BLIZZARD" },
              orderBy: { capturedAt: "desc" },
              select: {
                seasonId: true,
                currentRating: true,
                rioScore: true,
                weeklyHighest: true,
                weeklyRunCount: true,
                runsThisWeek: true,
                capturedAt: true,
              },
            }),
            ctx.db.vaultSnapshot.findFirst({
              where: { characterId: id },
              orderBy: { capturedAt: "desc" },
              select: {
                weekStart: true,
                slots: true,
                capturedAt: true,
              },
            }),
            ctx.db.raidSnapshot.findFirst({
              where: { characterId: id, source: "BLIZZARD" },
              orderBy: { capturedAt: "desc" },
              select: {
                tierId: true,
                expansionId: true,
                completions: true,
                seasonProgress: true,
                capturedAt: true,
              },
            }),
            ctx.db.wclParseSnapshot.findMany({
              where: { characterId: id },
              orderBy: { capturedAt: "desc" },
              // Parse ingestion writes rows per DIFFICULTY (up to 3 tiers ×
              // 9+ bosses) — 30 newest rows could crowd Mythic out entirely
              // for a multi-tier raider, blanking the Mythic-only widgets.
              take: 90,
              select: {
                zoneId: true,
                encounterId: true,
                encounterName: true,
                difficulty: true,
                percentile: true,
                weekPercentile: true,
                metric: true,
                reportCode: true,
                reportStartTime: true,
                capturedAt: true,
              },
            }),
            // Our own addon upload — the only authoritative source for the
            // World/Delve Great Vault row (no Blizzard web API exposes it).
            ctx.db.addonUpload.findUnique({
              where: { characterId: id },
              select: {
                worldUnlocked: true,
                worldTotal: true,
                collectedAt: true,
                receivedAt: true,
                addonVersion: true,
                // Addon-primary fields (Phase 5): the equipped iLvL the addon
                // read live, and the exact weekly M+ run count. Preferred over
                // the API values only when the capture is fresh (isAddonFresh).
                addonItemLevel: true,
                weeklyMplusRuns: true,
                payload: true,
              },
            }),
            ctx.db.professionSnapshot.findFirst({
              where: { characterId: id, source: "BLIZZARD" },
              orderBy: { capturedAt: "desc" },
              select: { professions: true, capturedAt: true },
            }),
          ]),
        ),
      );

      // The live raid tier's WCL zone id, resolved server-side (env-pinned
      // to the current Midnight raid → no network call). Widgets filter
      // parses to exactly this zone so stale past-expansion rows (e.g. The
      // War Within) can never leak into the current-tier views.
      // The CURRENT RELEASE's full raid-zone set (e.g. Midnight 12.0.7 →
      // [46, 50]) — patches add raids to a release, so the current tier is
      // normally MORE than one zone. `currentRaidZoneId` stays the primary
      // (newest) for back-compat. `currentZoneEncounters` is the merged boss
      // list across ALL release zones, each tagged with `zoneId`, so the matrix
      // widgets render a column for every boss in the release — incl. brand-new
      // ones nobody has parsed yet. Resolved/cached server-side (~free).
      const wcl = warcraftLogsClient();
      const currentRaidZoneIds = await wcl.currentRaidZoneIds();
      const currentRaidZoneId =
        currentRaidZoneIds.length > 0 ? Math.max(...currentRaidZoneIds) : null;
      const currentZoneEncounters =
        await wcl.currentReleaseEncounters(currentRaidZoneIds);

      return {
        currentRaidZoneId,
        currentRaidZoneIds,
        currentZoneEncounters,
        members: memberships.map((m, i) => {
          const eq = latest[i]![1];
          // Recompute the gear audit from the stored equipped items with
          // the Midnight-correct slot logic, so the per-slot hover detail
          // and the counts are always consistent and correct even on
          // snapshots written before the slot list was fixed. The bulky
          // raw `items` is intentionally NOT included in the payload —
          // only the compact derived detail is sent to the client.
          const equipment = eq
            ? (() => {
                const audit = computeGearAudit(eq.items);
                return {
                  itemLevel: eq.itemLevel,
                  tierSetPiecesCount: eq.tierSetPiecesCount,
                  tierSetIds: eq.tierSetIds,
                  tierSlots: eq.tierSlots,
                  capturedAt: eq.capturedAt,
                  missingEnchantsCount: audit.missingEnchantsCount,
                  missingGemsCount: audit.missingGemsCount,
                  missingEnchantSlots: audit.missingEnchantSlots,
                  missingGemSlots: audit.missingGemSlots,
                };
              })()
            : null;
          // Override the vault's World row from the addon upload when we
          // have one — it's the only authoritative source (Blizzard exposes
          // no Delve/World vault API). Raid + M+ stay as derived. If there's
          // no vault snapshot yet but an addon upload exists, synthesize a
          // minimal vault so the World row still shows.
          const vaultSnap = latest[i]![3];
          const addon = latest[i]![6];
          let vault = vaultSnap as
            | (NonNullable<typeof vaultSnap> & { slots: unknown })
            | null;
          if (addon && addon.worldUnlocked != null) {
            const baseSlots =
              (vaultSnap?.slots as Record<string, unknown> | null) ?? {};
            const mergedSlots = {
              ...baseSlots,
              world: {
                unlocked: addon.worldUnlocked,
                total: addon.worldTotal,
                tracks: [],
                tracked: true,
              },
            };
            vault = {
              weekStart: vaultSnap?.weekStart ?? null,
              capturedAt: vaultSnap?.capturedAt ?? addon.collectedAt,
              slots: mergedSlots,
            } as typeof vault;
          }
          const addonView = addon
            ? buildAddonView(
                addon.payload,
                addon.collectedAt,
                addon.addonVersion,
              )
            : null;
          // Companion install state for the App column. Per-user install flag
          // joined via the character's owner; lastReceivedAt is THIS
          // character's own most-recent addon upload. state="none" when the
          // user has no CompanionStatus or it's not installed; "warning" when
          // installed but no data has arrived in 7 days (or ever); else "ok".
          const companionRow = companionByUser.get(m.character.userId);
          const lastReceivedAt =
            companionRow?.installed === true
              ? (addon?.receivedAt ?? null)
              : null;
          const companionState: "none" | "ok" | "warning" =
            !companionRow || companionRow.installed !== true
              ? "none"
              : lastReceivedAt == null ||
                  companionNow - lastReceivedAt.getTime() > COMPANION_STALE_MS
                ? "warning"
                : "ok";
          // Installed-only: the user's last-seen companion + addon versions and
          // whether either is behind the latest published release (an asterisk
          // on the App column nudges an update without nagging).
          const isInstalled = companionRow?.installed === true;
          const companionVersion = isInstalled
            ? (companionRow?.lastSeenVersion ?? null)
            : null;
          const addonVersion = isInstalled
            ? (companionRow?.lastSeenAddonVersion ?? null)
            : null;
          const companion = {
            state: companionState,
            lastReceivedAt,
            companionVersion,
            addonVersion,
            companionOutdated: isOutdated(
              companionVersion,
              LATEST_COMPANION_VERSION,
            ),
            addonOutdated: isOutdated(addonVersion, LATEST_ADDON_VERSION),
          };

          // ── Phase 5: addon-as-primary / API-fallback for a SAFE subset ──
          // The addon reads live client state the web APIs lag or can't see.
          // We prefer the addon's value ONLY when the capture is FRESH (the
          // companion is actively reporting AND the snapshot is recent — see
          // isAddonFresh); otherwise the API value is used, which is also the
          // sole source for users without the companion. Scope is deliberately
          // narrow: equipped item level + the exact weekly M+ run count. WCL
          // parses, Raider.IO score, and the talent loadout stay API-only /
          // API-primary and are untouched here.
          const addonFresh = isAddonFresh({
            collectedAt: addon?.collectedAt ?? null,
            companionState,
            now: companionNow,
          });

          // Item level: addon's equipped iLvL over the Blizzard API iLvL
          // (equipment snapshot preferred, character snapshot as its own
          // fallback). The API value is retained as the fallback and is still
          // synced independently — we only override what the client displays.
          const charSnap = latest[i]![0];
          const apiItemLevel =
            equipment?.itemLevel ?? charSnap?.itemLevel ?? null;
          const resolvedItemLevel = resolveField({
            addonValue: addon?.addonItemLevel ?? null,
            apiValue: apiItemLevel,
            addonFresh,
          }).value;
          // Surface the resolved iLvL through both shapes the client reads
          // (`equipment.itemLevel ?? character.itemLevel`), so addon-fresh
          // members show the live value whether or not an equipment snapshot
          // exists. Gear-audit counts/slots are left exactly as derived.
          const character = charSnap
            ? { ...charSnap, itemLevel: resolvedItemLevel ?? charSnap.itemLevel }
            : charSnap;
          const resolvedEquipment = equipment
            ? { ...equipment, itemLevel: resolvedItemLevel ?? equipment.itemLevel }
            : equipment;

          // Weekly M+ run count: the addon's count is the authoritative EXACT
          // number (the API/RIO is only a lower bound). No new storage — the
          // addon's count already lives on AddonUpload.weeklyMplusRuns.
          const mplusSnap = latest[i]![2];
          const resolvedWeeklyRunCount = resolveField({
            addonValue: addon?.weeklyMplusRuns ?? null,
            apiValue: mplusSnap?.weeklyRunCount ?? null,
            addonFresh,
          }).value;
          const mplus = mplusSnap
            ? { ...mplusSnap, weeklyRunCount: resolvedWeeklyRunCount }
            : mplusSnap;

          return {
            character: m.character,
            role: m.role,
            rank: m.rank,
            companion,
            latest: {
              character,
              equipment: resolvedEquipment,
              mplus,
              vault,
              raid: latest[i]![4],
              wclParses: latest[i]![5],
              addon: addonView,
              professions: latest[i]![7]?.professions ?? null,
              professionsAt: latest[i]![7]?.capturedAt ?? null,
            },
          };
        }),
      };
    }),

  /**
   * Returns the full iLvL history for a single character — used by the
   * character-timeline widget. Caller must be a member (or guild staff) of
   * a raid team the character is on.
   */
  characterTimeline: publicProcedure
    .input(
      z.object({
        characterId: z.string().cuid(),
        days: z.number().int().min(7).max(180).default(60),
      }),
    )
    .query(async ({ ctx, input }) => {
      const empty = {
        points: [] as Array<{ at: Date; itemLevel: number | null }>,
      };
      const userId = ctx.session?.user?.id;
      let memberAccess = false;
      if (userId) {
        // Authorize via team membership: any team the character is on grants
        // access — we just check there's *some* shared team the caller can
        // read.
        const sharedMembership = await ctx.db.raidTeamMembership.findFirst({
          where: {
            characterId: input.characterId,
            isActive: true,
            raidTeam: {
              OR: [
                { memberships: { some: { character: { userId }, isActive: true } } },
                { guild: { memberships: { some: { userId, status: "ACTIVE", role: { in: ["OWNER", "OFFICER"] } } } } },
              ],
            },
          },
          select: { id: true },
        });
        memberAccess = sharedMembership != null;
        // A signed-in NON-member can still hold a public share link — fall
        // through to the token grant (matching assertTeamReadAccess: being
        // logged in must never grant LESS than incognito).
        if (!memberAccess && !ctx.shareToken) return empty;
      }
      if (!memberAccess) {
        // Anonymous public-share viewer: the share token's team must be one
        // the character is actively on, and the dashboard must be public —
        // both enforced by assertTeamReadAccess on the token's team.
        const { verifyShareToken } = await import(
          "@/server/security/share-token"
        );
        const verified = ctx.shareToken
          ? verifyShareToken(ctx.shareToken)
          : null;
        if (!verified) return empty;
        const onTokenTeam = await ctx.db.raidTeamMembership.findFirst({
          where: {
            characterId: input.characterId,
            isActive: true,
            raidTeamId: verified.raidTeamId,
          },
          select: { id: true },
        });
        if (!onTokenTeam) return empty;
        try {
          await assertTeamReadAccess(ctx, verified.raidTeamId);
        } catch {
          return empty;
        }
      }

      const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);
      const rows = await ctx.db.characterSnapshot.findMany({
        where: {
          characterId: input.characterId,
          source: "BLIZZARD",
          capturedAt: { gte: since },
        },
        orderBy: { capturedAt: "asc" },
        select: { capturedAt: true, itemLevel: true },
      });
      return {
        points: rows.map((r) => ({ at: r.capturedAt, itemLevel: r.itemLevel })),
      };
    }),

  /**
   * Per-DAY iLvL timeline for EVERY tracked character of a raid team, plus a
   * team "Average" series — used by the character-timeline widget's character
   * selector. Team-scoped auth (any member / guild staff / valid share token),
   * matching `latestForTeam` + `characterTimeline`.
   *
   * Bucketing rule: one bucket per calendar day in [now-days, now]. For each
   * character we forward-fill their last-known Blizzard-source itemLevel up to
   * each day (item level is a standing value, not an event, so carry-forward is
   * correct). The Average for a day is the mean over only the characters that
   * already have a known value by that day — a day BEFORE a character's first
   * snapshot contributes nothing for that character (honest about gaps).
   */
  teamItemLevelTimeline: publicProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        days: z.number().int().min(7).max(180).default(60),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Any team member, guild OWNER/OFFICER, or valid share token may read.
      await assertTeamReadAccess(ctx, input.raidTeamId);

      const memberships = await ctx.db.raidTeamMembership.findMany({
        where: { raidTeamId: input.raidTeamId, isActive: true },
        include: {
          character: { select: { id: true, name: true, classId: true } },
        },
      });
      const characters = memberships.map((m) => m.character);
      const characterIds = characters.map((c) => c.id);

      const DAY_MS = 24 * 60 * 60 * 1000;
      // Anchor the day buckets to UTC midnight so they're stable + deterministic.
      const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
      const startDay = todayStart - (input.days - 1) * DAY_MS;
      const dayCount = input.days;

      const emptyPoints = Array.from({ length: dayCount }, (_, i) => ({
        day: startDay + i * DAY_MS,
        average: null as number | null,
        byChar: {} as Record<string, number>,
      }));

      if (characterIds.length === 0) {
        return { characters, points: emptyPoints };
      }

      // One findMany over all characters; bucket + forward-fill in JS.
      const since = new Date(startDay);
      const rows = await ctx.db.characterSnapshot.findMany({
        where: {
          characterId: { in: characterIds },
          source: "BLIZZARD",
          capturedAt: { gte: since },
          itemLevel: { not: null },
        },
        orderBy: { capturedAt: "asc" },
        select: { characterId: true, capturedAt: true, itemLevel: true },
      });

      // Group ascending snapshots per character.
      const byChar = new Map<string, Array<{ dayIdx: number; ilvl: number }>>();
      for (const r of rows) {
        if (r.itemLevel == null) continue;
        const dayIdx = Math.floor((r.capturedAt.getTime() - startDay) / DAY_MS);
        const clamped = dayIdx < 0 ? 0 : dayIdx > dayCount - 1 ? dayCount - 1 : dayIdx;
        let list = byChar.get(r.characterId);
        if (!list) byChar.set(r.characterId, (list = []));
        list.push({ dayIdx: clamped, ilvl: r.itemLevel });
      }

      const points = emptyPoints.map((p) => ({
        day: p.day,
        average: null as number | null,
        byChar: {} as Record<string, number>,
      }));

      // Forward-fill each character across the day axis.
      for (const c of characters) {
        const list = byChar.get(c.id);
        if (!list || list.length === 0) continue;
        let cursor = 0;
        let last: number | null = null;
        for (let d = 0; d < dayCount; d++) {
          while (cursor < list.length && list[cursor]!.dayIdx <= d) {
            last = list[cursor]!.ilvl;
            cursor++;
          }
          if (last != null) points[d]!.byChar[c.id] = last;
        }
      }

      // Average over only the characters with a known value that day.
      for (const p of points) {
        const vals = Object.values(p.byChar);
        p.average =
          vals.length > 0
            ? vals.reduce((a, b) => a + b, 0) / vals.length
            : null;
      }

      return { characters, points };
    }),

  /**
   * One character's KNOWN recipes for the current expansion, grouped by the
   * in-game recipe CATEGORIES in display order ("sorted like in game") — behind
   * the Professions widget's per-player button. Reads the RAW snapshot (the
   * latestForTeam derived blob keeps only counts) and fetches+caches the
   * game-data categories. Same read access as characterTimeline.
   */
  professionRecipes: publicProcedure
    .input(z.object({ characterId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const empty = {
        character: null as { name: string; classId: number } | null,
        capturedAt: null as Date | null,
        professions: [] as Array<{
          profId: number;
          name: string;
          kind: "primary" | "secondary";
          tierName: string;
          recipeCount: number;
          sortedLikeInGame: boolean;
          groups: Array<{ category: string; recipes: Array<{ id: number; name: string }> }>;
        }>,
      };

      // Access mirrors characterTimeline: a shared team membership (or guild
      // staff), else a valid public share token whose team the character is on.
      const userId = ctx.session?.user?.id;
      let memberAccess = false;
      if (userId) {
        const shared = await ctx.db.raidTeamMembership.findFirst({
          where: {
            characterId: input.characterId,
            isActive: true,
            raidTeam: {
              OR: [
                { memberships: { some: { character: { userId }, isActive: true } } },
                { guild: { memberships: { some: { userId, status: "ACTIVE", role: { in: ["OWNER", "OFFICER"] } } } } },
              ],
            },
          },
          select: { id: true },
        });
        memberAccess = shared != null;
        if (!memberAccess && !ctx.shareToken) return empty;
      }
      if (!memberAccess) {
        const { verifyShareToken } = await import("@/server/security/share-token");
        const verified = ctx.shareToken ? verifyShareToken(ctx.shareToken) : null;
        if (!verified) return empty;
        const onTeam = await ctx.db.raidTeamMembership.findFirst({
          where: { characterId: input.characterId, isActive: true, raidTeamId: verified.raidTeamId },
          select: { id: true },
        });
        if (!onTeam) return empty;
        try {
          await assertTeamReadAccess(ctx, verified.raidTeamId);
        } catch {
          return empty;
        }
      }

      const snap = await ctx.db.professionSnapshot.findFirst({
        where: { characterId: input.characterId, source: "BLIZZARD" },
        orderBy: { capturedAt: "desc" },
        select: {
          rawPayload: true,
          capturedAt: true,
          character: { select: { name: true, classId: true, region: true } },
        },
      });
      if (!snap) return empty;

      const region = snap.character.region.toLowerCase();
      const professions: typeof empty.professions = [];
      for (const prof of extractCurrentTierKnown(snap.rawPayload)) {
        if (prof.knownRecipes.length === 0) continue;
        const categories = prof.tierId
          ? await getProfessionCategories(region, prof.profId, prof.tierId)
          : [];
        const groups =
          categories.length > 0
            ? groupKnownLikeInGame(prof.knownRecipes, categories)
            : groupKnownAlphabetical(prof.knownRecipes);
        professions.push({
          profId: prof.profId,
          name: prof.name,
          kind: prof.kind,
          tierName: prof.tierName,
          recipeCount: prof.knownRecipes.length,
          sortedLikeInGame: categories.length > 0,
          groups,
        });
      }
      return {
        character: { name: snap.character.name, classId: snap.character.classId },
        capturedAt: snap.capturedAt,
        professions,
      };
    }),

  /**
   * Parse consistency — the numbers leaders actually roster on: per-boss
   * season MEDIAN percentile, best-vs-median gap, per-kill volatility
   * (stdev over the ranks[] now persisted in rawPayload), and a
   * week-over-week RELATIVE improvement trend (member weekly median of
   * week-best kills minus the roster median, Theil–Sen slope).
   *
   * Reads only WclParseSnapshot (data the hourly sync already pays for).
   * Ingestion is per-DIFFICULTY (Normal/Heroic/Mythic rows, gated on the
   * tiers the member has season kills on) but dps-metric only — healer/
   * tank rows are flagged via spec-name role so the UI footnotes instead
   * of ranking them.
   */
  parseConsistency: publicProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        // WCL raid difficulty: 3 Normal, 4 Heroic, 5 Mythic. Omitted = the
        // highest difficulty the team actually has parse data for (the
        // tiers have non-equivalent parse populations — never mixed).
        difficulty: z
          .union([z.literal(3), z.literal(4), z.literal(5)])
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertTeamReadAccess(ctx, input.raidTeamId);

      const memberships = await ctx.db.raidTeamMembership.findMany({
        where: { raidTeamId: input.raidTeamId, isActive: true },
        include: {
          character: { select: { id: true, name: true, classId: true } },
        },
      });
      const characterIds = memberships.map((m) => m.character.id);
      // The current RELEASE's whole raid-zone set (patches are additive), so
      // consistency spans every current raid, not just the newest. `zoneId`
      // (primary) is still returned for back-compat.
      const resolvedZoneIds = await warcraftLogsClient().currentRaidZoneIds();
      const zoneIds = resolvedZoneIds.length > 0 ? resolvedZoneIds : [50];
      const zoneId = Math.max(...zoneIds);

      if (characterIds.length === 0) {
        return {
          zoneId,
          difficulty: input.difficulty ?? 5,
          availableDifficulties: [] as number[],
          partition: null as number | null,
          members: [],
          trendWeeks: [] as string[],
        };
      }

      const availRows = await ctx.db.wclParseSnapshot.findMany({
        where: {
          characterId: { in: characterIds },
          zoneId: { in: zoneIds },
          percentile: { not: null },
          // Recency bound so this distinct scan doesn't grow all season
          // (Prisma applies distinct in memory over the fetched rows).
          capturedAt: {
            gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
          },
        },
        distinct: ["difficulty"],
        select: { difficulty: true },
      });
      const availableDifficulties = availRows
        .map((r) => r.difficulty)
        .sort((a, b) => b - a);
      const selectedDifficulty =
        input.difficulty ?? availableDifficulties[0] ?? 5;

      const now = new Date();
      const currentWeek = weekStartUtc(now);
      const TREND_WEEKS = 8;
      const oldest = new Date(
        currentWeek.getTime() - TREND_WEEKS * 7 * 24 * 60 * 60 * 1000,
      );

      const [latestRows, specRows] = await Promise.all([
        // Latest row per (character, encounter): grab a recent window per
        // character and reduce in JS (mirrors latestForTeam's approach). The
        // latest row's rawPayload carries the FULL per-kill rank history (ranks
        // aggregate ALL public kills), which feeds both the volatility stat AND
        // the week-over-week trend — so no separate weekPercentile query.
        Promise.all(
          characterIds.map((id) =>
            ctx.db.wclParseSnapshot.findMany({
              where: {
                characterId: id,
                zoneId: { in: zoneIds },
                difficulty: selectedDifficulty,
              },
              orderBy: { capturedAt: "desc" },
              take: 60,
              select: {
                characterId: true,
                encounterId: true,
                encounterName: true,
                percentile: true,
                medianPercentile: true,
                bestAvg: true,
                medianAvg: true,
                capturedAt: true,
                // Parsed server-side for totalKills/volatility/partition/trend
                // ranks — never shipped to the client.
                rawPayload: true,
              },
            }),
          ),
        ),
        Promise.all(
          characterIds.map((id) =>
            ctx.db.characterSnapshot.findFirst({
              where: { characterId: id, source: "BLIZZARD" },
              orderBy: { capturedAt: "desc" },
              select: { characterId: true, specName: true },
            }),
          ),
        ),
      ]);

      const specByChar = new Map(
        specRows
          .filter((r): r is NonNullable<typeof r> => r != null)
          .map((r) => [r.characterId, r.specName]),
      );

      // ---- snapshot tab: latest per (char, encounter) + raw extraction ----
      type RawSeason = { totalKills?: unknown };
      type RawRank = { rankPercent?: unknown; percentile?: unknown };
      const readRaw = (raw: unknown) => {
        const obj =
          typeof raw === "object" && raw !== null
            ? (raw as Record<string, unknown>)
            : {};
        const season = (obj.season ?? {}) as RawSeason;
        const kills =
          typeof season.totalKills === "number" ? season.totalKills : null;
        const ranks = Array.isArray(obj.ranks)
          ? (obj.ranks as RawRank[])
              .map((r) =>
                typeof r?.rankPercent === "number"
                  ? r.rankPercent
                  : typeof r?.percentile === "number"
                    ? r.percentile
                    : null,
              )
              .filter((v): v is number => v != null)
          : [];
        // Negative partition = WCL's request-echo sentinel (-1 "current"),
        // present in early rows — never a real partition number.
        const partition =
          typeof obj.partition === "number" && obj.partition >= 0
            ? obj.partition
            : null;
        return { kills, ranks, partition };
      };

      let partition: number | null = null;
      const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
      const weekIndexOf = (ms: number): number =>
        Math.floor((ms - oldest.getTime()) / WEEK_MS);

      // Per (char, week, encounter) keep the BEST per-kill percentile, sourced
      // from the full rank history in each character's latest row per encounter
      // (ranks aggregate ALL kills, so the week-over-week signal is available
      // from the first fetch). The old weekPercentile column only ever captured
      // the CURRENT lockout, which left the trend starved for most rosters.
      const weekBest = new Map<string, number>();
      for (let i = 0; i < characterIds.length; i++) {
        const charId = characterIds[i]!;
        const seenEnc = new Set<number>();
        for (const r of latestRows[i] ?? []) {
          if (seenEnc.has(r.encounterId)) continue; // latest row per encounter
          seenEnc.add(r.encounterId);
          for (const rk of extractKillRanks(r.rawPayload)) {
            const idx = weekIndexOf(rk.t);
            if (idx < 0 || idx >= TREND_WEEKS) continue; // window only
            const key = `${charId}|${idx}|${r.encounterId}`;
            const prev = weekBest.get(key);
            if (prev == null || rk.pct > prev) weekBest.set(key, rk.pct);
          }
        }
      }
      // char|week → list of per-encounter week-bests
      const charWeekValues = new Map<string, number[]>();
      for (const [key, v] of weekBest) {
        const [charId, idx] = [
          key.slice(0, key.indexOf("|")),
          key.slice(key.indexOf("|") + 1, key.lastIndexOf("|")),
        ];
        const k = `${charId}|${idx}`;
        charWeekValues.set(k, [...(charWeekValues.get(k) ?? []), v]);
      }
      // Member weekly medians (qualify: ≥2 encounters that week).
      const memberWeekMedian = new Map<string, number>();
      for (const [k, values] of charWeekValues) {
        if (values.length < 2) continue;
        const med = medianOf(values);
        if (med != null) memberWeekMedian.set(k, med);
      }
      // Roster median per week — DPS members only. Ingestion is dps-metric;
      // healer/tank medians measure the wrong job and would perturb the
      // baseline everyone's rel_w is computed against (their own rows still
      // render, footnoted, compared against the dps baseline).
      const dpsChars = new Set(
        characterIds.filter((id) => roleOf(specByChar.get(id)) === "dps"),
      );
      const rosterWeek = new Map<number, number[]>();
      for (const [k, med] of memberWeekMedian) {
        const charId = k.slice(0, k.indexOf("|"));
        if (!dpsChars.has(charId)) continue;
        const idx = Number(k.slice(k.indexOf("|") + 1));
        rosterWeek.set(idx, [...(rosterWeek.get(idx) ?? []), med]);
      }
      const rosterWeekMedian = new Map<number, number>();
      for (const [idx, meds] of rosterWeek) {
        const med = medianOf(meds);
        if (med != null && meds.length >= 2) rosterWeekMedian.set(idx, med);
      }

      const members = memberships.map((m, i) => {
        const rows = latestRows[i] ?? [];
        const latestByEncounter = new Map<string, (typeof rows)[number]>();
        for (const r of rows) {
          const k = String(r.encounterId);
          if (!latestByEncounter.has(k)) latestByEncounter.set(k, r); // desc order
        }
        const encounters = [...latestByEncounter.values()]
          .map((r) => {
            const raw = readRaw(r.rawPayload);
            // Partitions only ever increase; after a flip, inactive members'
            // latest rows still carry the OLD partition — take the max so a
            // stale row can't mask the reset.
            if (
              raw.partition != null &&
              (partition == null || raw.partition > partition)
            ) {
              partition = raw.partition;
            }
            return {
              encounterId: r.encounterId,
              encounterName: r.encounterName,
              best: r.percentile,
              median: r.medianPercentile,
              kills: raw.kills,
              volatility: raw.ranks.length >= 4 ? stdevOf(raw.ranks) : null,
            };
          })
          // Keep a boss if WCL rated it (best/median present) OR the team has a
          // logged KILL on it — so a brand-new boss WCL hasn't scored yet (e.g.
          // Rotmire) stays selectable and the widget can flag "logged, not rated
          // yet". Never-killed all-null rows (kills 0) are still dropped so the
          // dropdown stays clean + the empty state can trigger.
          .filter(
            (e) => e.best != null || e.median != null || (e.kills ?? 0) > 0,
          );
        // WCL returns 0 (NOT null) for a logged-but-UNRATED boss — verified live:
        // a fresh boss like Rotmire stores kills=1 with pct/med/bestAvg/medAvg
        // all 0. Treat 0 as "no score" everywhere via `hasScore`, so an unrated
        // boss can never mask real data.
        const hasScore = (v: number | null | undefined): v is number =>
          v != null && v > 0;
        // The newest stored row may BE the unrated boss (bestAvg 0). Require
        // BOTH aggregates to be real so we never pair a real WCL best with a
        // computed-fallback median — WCL emits bestPerformanceAverage +
        // medianPerformance together (both real, or both 0/absent), so the `&&`
        // never drops a usable row in practice while keeping the pair coherent.
        const latestWithAvg = rows.find(
          (r) => hasScore(r.bestAvg) && hasScore(r.medianAvg),
        );
        const avgOf = (xs: number[]): number | null =>
          xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;
        // Fallback when no real whole-zone aggregate exists (e.g. a multi-raid
        // release where WCL only aggregates per zone): average the per-boss
        // scores that actually exist (>0), so the "All" row reflects the scored
        // bosses instead of blanking. Taken as a coherent pair (both computed).
        const zoneBestAvg = latestWithAvg
          ? latestWithAvg.bestAvg
          : avgOf(encounters.map((e) => e.best).filter(hasScore));
        const zoneMedianAvg = latestWithAvg
          ? latestWithAvg.medianAvg
          : avgOf(encounters.map((e) => e.median).filter(hasScore));

        // Trend: rel_w over closed weeks where BOTH the member qualifies
        // and a roster median exists; benched weeks are simply absent.
        const trend: Array<{ weekStart: string; median: number; rel: number }> =
          [];
        for (let idx = 0; idx < TREND_WEEKS; idx++) {
          const med = memberWeekMedian.get(`${m.character.id}|${idx}`);
          const roster = rosterWeekMedian.get(idx);
          if (med == null || roster == null) continue;
          trend.push({
            weekStart: new Date(
              oldest.getTime() + idx * WEEK_MS,
            ).toISOString(),
            median: med,
            rel: med - roster,
          });
        }
        const relSeries = trend.slice(-6).map((t) => t.rel);
        const slope = relSeries.length >= 3 ? theilSen(relSeries) : null;

        return {
          character: m.character,
          specName: specByChar.get(m.character.id) ?? null,
          role: roleOf(specByChar.get(m.character.id)),
          bestAvg: zoneBestAvg,
          medianAvg: zoneMedianAvg,
          encounters,
          trend,
          slope,
          qualifyingWeeks: relSeries.length,
        };
      });

      return {
        zoneId,
        difficulty: selectedDifficulty,
        availableDifficulties,
        partition,
        members,
        trendWeeks: Array.from({ length: TREND_WEEKS }, (_, idx) =>
          new Date(oldest.getTime() + idx * WEEK_MS).toISOString(),
        ),
      };
    }),

  /**
   * Progression pulls — per-pull fight rows ingested by Guild Report Sync,
   * for the prog_curve widget. Read-only over our own tables: zero WCL
   * spend at request time. Returns the raw pulls (8 weeks) plus an
   * encounter-name map derived from the team's parse snapshots; dedupe,
   * throwaway filtering, night clustering, and trend math live client-side
   * in src/lib/prog-curve.ts so axis/filter toggles don't refetch.
   */
  progressionPulls: publicProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const { guildId } = await assertTeamReadAccess(ctx, input.raidTeamId);

      // The team's effective log source: its override, else the guild's
      // resolved WCL guild. Every widget on a team dashboard reads exactly
      // this source — plus member-swept reports (wclGuildId null), which
      // are shared guild-wide and gated below to fights where >=2 of THIS
      // team's roster actually participated.
      const team = await ctx.db.raidTeam.findUnique({
        where: { id: input.raidTeamId },
        select: {
          wclGuildId: true,
          wclGuildName: true,
          guild: { select: { wclGuildId: true, name: true } },
          memberships: {
            where: { isActive: true },
            select: { characterId: true },
          },
        },
      });
      const effectiveSource =
        team?.wclGuildId ?? team?.guild.wclGuildId ?? null;
      const source = {
        wclGuildId: effectiveSource,
        name:
          team?.wclGuildId != null
            ? (team.wclGuildName ?? `WCL guild #${team.wclGuildId}`)
            : (team?.guild.name ?? "Guild logs"),
        isOverride: team?.wclGuildId != null,
      };
      const teamCharacterIds = team?.memberships.map((m) => m.characterId) ?? [];

      const sourceClauses: Array<{ wclGuildId: number | null }> = [
        { wclGuildId: null },
      ];
      if (effectiveSource != null) {
        sourceClauses.push({ wclGuildId: effectiveSource });
      }

      const since = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000);
      const reports = await ctx.db.wclReport.findMany({
        // revision >= 0 excludes tombstones (inaccessible/roster-gated
        // reports, revision -1): they carry real timestamps but no fights,
        // and would otherwise inflate reportCount and skew newestReportAt
        // (suppressing the stale-log note off a foreign pug's date).
        where: {
          guildId,
          startTime: { gte: since },
          revision: { gte: 0 },
          OR: sourceClauses,
        },
        select: {
          code: true,
          zoneId: true,
          startTime: true,
          endTime: true,
          wclGuildId: true,
        },
      });
      if (reports.length === 0) {
        return {
          pulls: [],
          encounterNames: {} as Record<number, string>,
          reportCount: 0,
          newestReportAt: null as Date | null,
          source,
        };
      }
      const reportByCode = new Map(reports.map((r) => [r.code, r]));

      const allFights = await ctx.db.wclFight.findMany({
        where: { reportCode: { in: reports.map((r) => r.code) } },
        select: {
          reportCode: true,
          fightId: true,
          encounterId: true,
          difficulty: true,
          kill: true,
          bossPct: true,
          fightPct: true,
          lastPhase: true,
          startAt: true,
          endAt: true,
          durationMs: true,
          friendlyPlayerIds: true,
        },
      });

      // Participation gate for member-swept reports: a swept report is in
      // the guild-wide pool, so a fight only counts for THIS team when >=2
      // of its roster were in the pull (mirrors the persist-time roster
      // gate; keeps team A's pugs/raids out of team B's progression view).
      const sweptCodes = reports
        .filter((r) => r.wclGuildId == null)
        .map((r) => r.code);
      const teamActorsByReport = new Map<string, Set<number>>();
      if (sweptCodes.length > 0 && teamCharacterIds.length > 0) {
        const actorRows = await ctx.db.wclReportActor.findMany({
          where: {
            reportCode: { in: sweptCodes },
            characterId: { in: teamCharacterIds },
          },
          select: { reportCode: true, actorId: true },
        });
        for (const a of actorRows) {
          const s = teamActorsByReport.get(a.reportCode) ?? new Set<number>();
          s.add(a.actorId);
          teamActorsByReport.set(a.reportCode, s);
        }
      }
      const fights = allFights.filter((f) => {
        const rep = reportByCode.get(f.reportCode);
        if (rep?.wclGuildId != null) return true; // the team's own source
        const teamActors = teamActorsByReport.get(f.reportCode);
        if (!teamActors) return false;
        let matches = 0;
        for (const id of f.friendlyPlayerIds) {
          if (teamActors.has(id)) {
            matches++;
            if (matches >= 2) return true;
          }
        }
        return false;
      });

      // Report stats AFTER the gate, so another team's personal logs can't
      // inflate the count or suppress the stale-log note: sourced reports
      // always count (they ARE the team's logs, fights or not); swept
      // reports only count when a fight survived the participation gate.
      const usedCodes = new Set(fights.map((f) => f.reportCode));
      const teamReports = reports.filter(
        (r) => r.wclGuildId != null || usedCodes.has(r.code),
      );
      const newestReportAt = teamReports.reduce<Date | null>(
        (max, r) => (max == null || r.startTime > max ? r.startTime : max),
        null,
      );

      // Boss names ride along from parse snapshots (the fights query's
      // verified field set doesn't include a name); unmatched encounters
      // render as "Encounter <id>" client-side. Scoped to the encounter ids
      // actually present so the lookup stays bounded as the append-only
      // parse table grows across seasons.
      const presentEncounterIds = [
        ...new Set(fights.map((f) => f.encounterId)),
      ];
      const nameRows = presentEncounterIds.length
        ? await ctx.db.wclParseSnapshot.findMany({
            where: {
              encounterId: { in: presentEncounterIds },
              encounterName: { not: null },
            },
            distinct: ["encounterId"],
            select: { encounterId: true, encounterName: true },
          })
        : [];
      const encounterNames: Record<number, string> = {};
      for (const n of nameRows) {
        if (n.encounterName) encounterNames[n.encounterId] = n.encounterName;
      }

      return {
        pulls: fights.map((f) => {
          const r = reportByCode.get(f.reportCode)!;
          return {
            reportCode: f.reportCode,
            fightId: f.fightId,
            encounterId: f.encounterId,
            difficulty: f.difficulty,
            kill: f.kill,
            bossPct: f.bossPct,
            fightPct: f.fightPct,
            lastPhase: f.lastPhase,
            startAt: f.startAt.getTime(),
            endAt: f.endAt.getTime(),
            durationMs: f.durationMs,
            reportDurationMs: Math.max(
              0,
              r.endTime.getTime() - r.startTime.getTime(),
            ),
          };
        }),
        encounterNames,
        reportCount: teamReports.length,
        newestReportAt,
        source,
      };
    }),

  /**
   * First-Death Ledger — per-boss, per-player first/early-death rates from
   * the WCL deaths layer (WclFightDeath, written by GRS alongside fights).
   * Reads ONLY stored tables (zero WCL spend at request time), mirroring
   * progressionPulls' source resolution + the ≥2-roster participation gate
   * for member-swept reports so the pull set matches prog_curve. All ranking
   * math lives in @/lib/first-death-ledger.
   */
  firstDeathLedger: publicProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertTeamReadAccess(ctx, input.raidTeamId);

      const team = await ctx.db.raidTeam.findUnique({
        where: { id: input.raidTeamId },
        select: {
          wclGuildId: true,
          wclGuildName: true,
          guild: { select: { id: true, wclGuildId: true, name: true } },
          memberships: {
            where: { isActive: true },
            select: {
              characterId: true,
              character: { select: { name: true, classId: true } },
            },
          },
        },
      });
      const guildId = team?.guild.id ?? null;
      const effectiveSource = team?.wclGuildId ?? team?.guild.wclGuildId ?? null;
      const source = {
        wclGuildId: effectiveSource,
        name:
          team?.wclGuildId != null
            ? (team.wclGuildName ?? `WCL guild #${team.wclGuildId}`)
            : (team?.guild.name ?? "Guild logs"),
        isOverride: team?.wclGuildId != null,
      };
      const memberMeta = new Map(
        (team?.memberships ?? []).map((m) => [
          m.characterId,
          { name: m.character.name, classId: m.character.classId },
        ]),
      );
      const teamCharacterIds = [...memberMeta.keys()];

      const members: Record<string, { name: string; classId: number | null }> =
        {};
      for (const [cid, meta] of memberMeta) members[cid] = meta;

      const empty = {
        encounters: [] as LedgerEncounter[],
        encounterNames: {} as Record<number, string>,
        members,
        reportCount: 0,
        source,
      };
      if (!guildId || teamCharacterIds.length === 0) return empty;

      const sourceClauses: Array<{ wclGuildId: number | null }> = [
        { wclGuildId: null },
      ];
      if (effectiveSource != null) {
        sourceClauses.push({ wclGuildId: effectiveSource });
      }

      const since = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000);
      const reports = await ctx.db.wclReport.findMany({
        where: {
          guildId,
          startTime: { gte: since },
          revision: { gte: 0 },
          OR: sourceClauses,
        },
        select: { code: true, wclGuildId: true },
      });
      if (reports.length === 0) return empty;
      const reportCodes = reports.map((r) => r.code);
      const sourcedCodes = new Set(
        reports.filter((r) => r.wclGuildId != null).map((r) => r.code),
      );

      const [fightRows, deathRows, actorRows, observedReports] =
        await Promise.all([
          ctx.db.wclFight.findMany({
            where: { reportCode: { in: reportCodes } },
            select: {
              reportCode: true,
              fightId: true,
              encounterId: true,
              difficulty: true,
              kill: true,
              startAt: true,
              friendlyPlayerIds: true,
            },
          }),
          ctx.db.wclFightDeath.findMany({
            where: {
              reportCode: { in: reportCodes },
              characterId: { in: teamCharacterIds },
            },
            select: {
              reportCode: true,
              fightId: true,
              encounterId: true,
              difficulty: true,
              kill: true,
              characterId: true,
              deathOrder: true,
              deathAt: true,
              killingAbilityName: true,
              overkill: true,
            },
          }),
          ctx.db.wclReportActor.findMany({
            where: {
              reportCode: { in: reportCodes },
              characterId: { in: teamCharacterIds },
            },
            select: { reportCode: true, actorId: true, characterId: true },
          }),
          // Which reports have a death layer at all (any death row, team or
          // not) — only their pulls are "observed" for the rate denominators.
          ctx.db.wclFightDeath.findMany({
            where: { reportCode: { in: reportCodes } },
            distinct: ["reportCode"],
            select: { reportCode: true },
          }),
        ]);
      const observedReportCodes = new Set(
        observedReports.map((r) => r.reportCode),
      );

      // (reportCode → (report-local actorId → our characterId)), team only.
      const actorMapByReport = new Map<string, Map<number, string>>();
      for (const a of actorRows) {
        if (!a.characterId) continue;
        let m = actorMapByReport.get(a.reportCode);
        if (!m) {
          m = new Map();
          actorMapByReport.set(a.reportCode, m);
        }
        m.set(a.actorId, a.characterId);
      }

      // Gated fights + a (reportCode|fightId → startAt) lookup for the deaths.
      const fightStartByKey = new Map<string, number>();
      const gatedFightKeys = new Set<string>();
      const fights: LedgerFight[] = [];
      for (const f of fightRows) {
        const actorMap = actorMapByReport.get(f.reportCode);
        const present = new Set<string>();
        if (actorMap) {
          for (const aid of f.friendlyPlayerIds) {
            const cid = actorMap.get(aid);
            if (cid) present.add(cid);
          }
        }
        // Participation gate: the team's own sourced reports always count;
        // member-swept reports need ≥2 of the roster in the pull.
        if (!sourcedCodes.has(f.reportCode) && present.size < 2) continue;
        const key = `${f.reportCode}|${f.fightId}`;
        gatedFightKeys.add(key);
        fightStartByKey.set(key, f.startAt.getTime());
        fights.push({
          encounterId: f.encounterId,
          difficulty: f.difficulty,
          kill: f.kill,
          presentCharacterIds: [...present],
          observed: observedReportCodes.has(f.reportCode),
        });
      }

      const deaths: LedgerDeath[] = [];
      for (const d of deathRows) {
        const key = `${d.reportCode}|${d.fightId}`;
        if (!gatedFightKeys.has(key)) continue; // gated-out pull
        const start = fightStartByKey.get(key)!;
        deaths.push({
          encounterId: d.encounterId,
          difficulty: d.difficulty,
          kill: d.kill,
          characterId: d.characterId, // already ∈ team roster (queried)
          deathOrder: d.deathOrder,
          msIntoPull: Math.max(0, d.deathAt.getTime() - start),
          killingAbilityName: d.killingAbilityName,
          overkill: d.overkill != null ? Number(d.overkill) : null,
        });
      }

      const encounters = aggregateLedger(fights, deaths);

      // Boss names ride from parse snapshots (same as progressionPulls).
      const encIds = [...new Set(encounters.map((e) => e.encounterId))];
      const nameRows = encIds.length
        ? await ctx.db.wclParseSnapshot.findMany({
            where: {
              encounterId: { in: encIds },
              encounterName: { not: null },
            },
            distinct: ["encounterId"],
            select: { encounterId: true, encounterName: true },
          })
        : [];
      const encounterNames: Record<number, string> = {};
      for (const n of nameRows) {
        if (n.encounterName) encounterNames[n.encounterId] = n.encounterName;
      }

      // Post-gate report count (mirrors progressionPulls): a sourced report
      // always counts; a member-swept report counts only when a fight of its
      // survived the participation gate — so another team's pug logs can't
      // inflate "N logs analyzed".
      const usedCodes = new Set(
        [...gatedFightKeys].map((k) => k.slice(0, k.lastIndexOf("|"))),
      );
      const reportCount = reports.filter(
        (r) => r.wclGuildId != null || usedCodes.has(r.code),
      ).length;

      return {
        encounters,
        encounterNames,
        members,
        reportCount,
        source,
      };
    }),

  /**
   * Cooldown Usage — log-derived "did the dying player have a PERSONAL defensive
   * active?" coaching view. Reuses the deaths layer (WclFightDeath) enriched
   * with the cooldown columns (GRS Buffs/Casts pass). Same source-resolution +
   * participation gating as firstDeathLedger; WIPE deaths only; aggregated per
   * difficulty into overall coverage + a per-player table (who isn't mitigating
   * the hits that kill them) + a per-mechanic table (what the team eats raw).
   */
  cooldownUsage: publicProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertTeamReadAccess(ctx, input.raidTeamId);

      const team = await ctx.db.raidTeam.findUnique({
        where: { id: input.raidTeamId },
        select: {
          wclGuildId: true,
          wclGuildName: true,
          guild: { select: { id: true, wclGuildId: true, name: true } },
          memberships: {
            where: { isActive: true },
            select: {
              characterId: true,
              character: { select: { name: true, classId: true } },
            },
          },
        },
      });
      const guildId = team?.guild.id ?? null;
      const effectiveSource = team?.wclGuildId ?? team?.guild.wclGuildId ?? null;
      const source = {
        wclGuildId: effectiveSource,
        name:
          team?.wclGuildId != null
            ? (team.wclGuildName ?? `WCL guild #${team.wclGuildId}`)
            : (team?.guild.name ?? "Guild logs"),
        isOverride: team?.wclGuildId != null,
      };
      const memberMeta = new Map(
        (team?.memberships ?? []).map((m) => [
          m.characterId,
          { name: m.character.name, classId: m.character.classId },
        ]),
      );
      const teamCharacterIds = [...memberMeta.keys()];
      const members: Record<string, { name: string; classId: number | null }> =
        {};
      for (const [cid, meta] of memberMeta) members[cid] = meta;

      const empty = {
        difficulties: [] as CooldownDifficultyAgg[],
        members,
        reportCount: 0,
        source,
        reports: [] as Array<{ code: string; title: string | null; startAtMs: number }>,
        encounters: [] as Array<{ encounterId: number; name: string }>,
        fights: [] as Array<{
          reportCode: string;
          fightId: number;
          encounterId: number;
          difficulty: number;
          kill: boolean;
          bossPct: number | null;
          pullNumber: number | null;
        }>,
        deaths: [] as Array<{
          reportCode: string;
          fightId: number;
          targetActorId: number;
          characterId: string | null;
          targetName: string | null;
          encounterId: number;
          difficulty: number;
          deathAtMs: number;
          deathOrder: number;
          overkill: number | null;
          killingAbilityName: string | null;
          defensiveActiveName: string | null;
          lastDefensiveCastMsBefore: number | null;
          pullNumber: number | null;
          bossPct: number | null;
        }>,
      };
      if (!guildId || teamCharacterIds.length === 0) return empty;

      const sourceClauses: Array<{ wclGuildId: number | null }> = [
        { wclGuildId: null },
      ];
      if (effectiveSource != null) sourceClauses.push({ wclGuildId: effectiveSource });

      const since = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000);
      const reports = await ctx.db.wclReport.findMany({
        where: {
          guildId,
          startTime: { gte: since },
          revision: { gte: 0 },
          OR: sourceClauses,
        },
        select: { code: true, wclGuildId: true, title: true, startTime: true },
      });
      if (reports.length === 0) return empty;
      const reportCodes = reports.map((r) => r.code);
      const sourcedCodes = new Set(
        reports.filter((r) => r.wclGuildId != null).map((r) => r.code),
      );

      const [fightRows, deathRows, actorRows] = await Promise.all([
        ctx.db.wclFight.findMany({
          where: { reportCode: { in: reportCodes } },
          select: {
            reportCode: true,
            fightId: true,
            encounterId: true,
            difficulty: true,
            kill: true,
            bossPct: true,
            startAt: true,
            friendlyPlayerIds: true,
          },
        }),
        ctx.db.wclFightDeath.findMany({
          where: {
            reportCode: { in: reportCodes },
            kill: false,
          },
          orderBy: { deathAt: "desc" },
          select: {
            reportCode: true,
            fightId: true,
            encounterId: true,
            difficulty: true,
            kill: true,
            characterId: true,
            targetActorId: true,
            deathAt: true,
            deathOrder: true,
            overkill: true,
            killingAbilityGameId: true,
            killingAbilityName: true,
            defensiveActiveGameId: true,
            defensiveActiveName: true,
            lastDefensiveCastMsBefore: true,
            cooldownsFetchedAt: true,
          },
        }),
        ctx.db.wclReportActor.findMany({
          where: {
            reportCode: { in: reportCodes },
          },
          select: {
            reportCode: true,
            actorId: true,
            characterId: true,
            name: true,
          },
        }),
      ]);

      // (reportCode → (actorId → characterId)), team only.
      const actorMapByReport = new Map<string, Map<number, string>>();
      // (reportCode → (actorId → name)), ALL friendly actors — used to label the
      // death of a non-roster raider (characterId = null) on the death list.
      const actorNameByReport = new Map<string, Map<number, string>>();
      for (const a of actorRows) {
        if (a.name != null) {
          let nm = actorNameByReport.get(a.reportCode);
          if (!nm) {
            nm = new Map();
            actorNameByReport.set(a.reportCode, nm);
          }
          nm.set(a.actorId, a.name);
        }
        if (!a.characterId) continue;
        let m = actorMapByReport.get(a.reportCode);
        if (!m) {
          m = new Map();
          actorMapByReport.set(a.reportCode, m);
        }
        m.set(a.actorId, a.characterId);
      }

      // Participation gate (mirrors firstDeathLedger): sourced reports always
      // count; member-swept reports need ≥2 of the roster in the pull.
      const gatedFightKeys = new Set<string>();
      for (const f of fightRows) {
        const actorMap = actorMapByReport.get(f.reportCode);
        let present = 0;
        if (actorMap) {
          for (const aid of f.friendlyPlayerIds) if (actorMap.get(aid)) present++;
        }
        if (!sourcedCodes.has(f.reportCode) && present < 2) continue;
        gatedFightKeys.add(`${f.reportCode}|${f.fightId}`);
      }

      const deaths: CooldownDeathInput[] = [];
      for (const d of deathRows) {
        if (!gatedFightKeys.has(`${d.reportCode}|${d.fightId}`)) continue;
        deaths.push({
          encounterId: d.encounterId,
          difficulty: d.difficulty,
          kill: d.kill,
          characterId: d.characterId,
          killingAbilityGameId: d.killingAbilityGameId,
          killingAbilityName: d.killingAbilityName,
          defensiveActiveGameId: d.defensiveActiveGameId,
          lastDefensiveCastMsBefore: d.lastDefensiveCastMsBefore,
          computed: d.cooldownsFetchedAt != null,
        });
      }

      const difficulties = aggregateCooldownUsage(deaths);

      const usedCodes = new Set(
        [...gatedFightKeys].map((k) => k.slice(0, k.lastIndexOf("|"))),
      );
      const reportCount = reports.filter(
        (r) => r.wclGuildId != null || usedCodes.has(r.code),
      ).length;

      // ── Dropdown facets + clickable death list (all from the rows above) ──
      // Pull number = chronological index of a fight among same-boss pulls.
      const fightMeta = new Map<
        string,
        { pullNumber: number; bossPct: number | null; kill: boolean }
      >();
      {
        const groups = new Map<string, typeof fightRows>();
        for (const f of fightRows) {
          const gk = `${f.reportCode}|${f.encounterId}|${f.difficulty}`;
          const arr = groups.get(gk);
          if (arr) arr.push(f);
          else groups.set(gk, [f]);
        }
        for (const g of groups.values()) {
          g.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
          g.forEach((f, i) =>
            fightMeta.set(`${f.reportCode}|${f.fightId}`, {
              pullNumber: i + 1,
              bossPct: f.bossPct,
              kill: f.kill,
            }),
          );
        }
      }

      const deathList: typeof empty.deaths = [];
      for (const d of deathRows) {
        const fk = `${d.reportCode}|${d.fightId}`;
        if (!gatedFightKeys.has(fk)) continue;
        const m = fightMeta.get(fk);
        deathList.push({
          reportCode: d.reportCode,
          fightId: d.fightId,
          targetActorId: d.targetActorId,
          characterId: d.characterId,
          targetName:
            actorNameByReport.get(d.reportCode)?.get(d.targetActorId) ?? null,
          encounterId: d.encounterId,
          difficulty: d.difficulty,
          deathAtMs: d.deathAt.getTime(),
          deathOrder: d.deathOrder,
          overkill: d.overkill != null ? Number(d.overkill) : null,
          killingAbilityName: d.killingAbilityName,
          defensiveActiveName: d.defensiveActiveName,
          lastDefensiveCastMsBefore: d.lastDefensiveCastMsBefore,
          pullNumber: m?.pullNumber ?? null,
          bossPct: m?.bossPct ?? null,
        });
        if (deathList.length >= 1000) break;
      }

      const reportHasDeath = new Set(deathList.map((d) => d.reportCode));
      const reportsFacet = reports
        .filter((r) => reportHasDeath.has(r.code))
        .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
        .map((r) => ({
          code: r.code,
          title: r.title,
          startAtMs: r.startTime.getTime(),
        }));

      const encIds = [...new Set(deathList.map((d) => d.encounterId))];
      const nameRows = encIds.length
        ? await ctx.db.wclParseSnapshot.findMany({
            where: { encounterId: { in: encIds }, encounterName: { not: null } },
            distinct: ["encounterId"],
            select: { encounterId: true, encounterName: true },
          })
        : [];
      const encNames: Record<number, string> = {};
      for (const n of nameRows)
        if (n.encounterName) encNames[n.encounterId] = n.encounterName;
      const encountersFacet = encIds
        .map((id) => ({ encounterId: id, name: encNames[id] ?? `Boss ${id}` }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const fightSeen = new Set<string>();
      const fightsFacet: typeof empty.fights = [];
      for (const d of deathList) {
        const fk = `${d.reportCode}|${d.fightId}`;
        if (fightSeen.has(fk)) continue;
        fightSeen.add(fk);
        const m = fightMeta.get(fk);
        fightsFacet.push({
          reportCode: d.reportCode,
          fightId: d.fightId,
          encounterId: d.encounterId,
          difficulty: d.difficulty,
          kill: m?.kill ?? false,
          bossPct: m?.bossPct ?? null,
          pullNumber: m?.pullNumber ?? null,
        });
      }

      return {
        difficulties,
        members,
        reportCount,
        source,
        reports: reportsFacet,
        encounters: encountersFacet,
        fights: fightsFacet,
        deaths: deathList,
      };
    }),

  /**
   * Death Context — on-demand, verbose context for ONE clicked death in the
   * cooldown_usage widget. Fetches a small WCL event window around the death
   * (boss damage taken, the player's casts, healing received) and reads the
   * defensives that were active at the fatal hit straight off that damage row's
   * buffs list. Cached in Redis keyed on the death identity (a frozen report's
   * window is immutable). Costs ~3 small WCL calls per click; the client's
   * points-budget guard refuses gracefully if the hour is exhausted.
   */
  deathContext: publicProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        reportCode: z.string().min(1).max(64),
        fightId: z.number().int().nonnegative(),
        targetActorId: z.number().int(),
        deathAtMs: z.number().int().nonnegative(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { guildId } = await assertTeamReadAccess(ctx, input.raidTeamId);

      const report = await ctx.db.wclReport.findUnique({
        where: { code: input.reportCode },
        select: { startTime: true, guildId: true, frozen: true },
      });
      // Only let a team read a report that belongs to its own guild.
      if (!report || report.guildId !== guildId) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const death = await ctx.db.wclFightDeath.findFirst({
        where: {
          reportCode: input.reportCode,
          fightId: input.fightId,
          targetActorId: input.targetActorId,
        },
        select: { killingAbilityGameId: true, killingAbilityName: true },
      });

      const WINDOW_MS = 10_000;
      const relMs = input.deathAtMs - report.startTime.getTime();
      const startTime = Math.max(0, relMs - WINDOW_MS);
      const endTime = relMs + 250;

      const cacheKey = `death-ctx:${input.reportCode}:${input.fightId}:${input.targetActorId}:${input.deathAtMs}`;
      try {
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached) as DeathContextResult;
      } catch {
        /* cache miss/outage — fall through to fetch */
      }

      const wcl = warcraftLogsClient();
      const vars = {
        code: input.reportCode,
        fightIDs: [input.fightId],
        startTime,
        endTime,
      };

      // Report master-data dictionary (ability id→name + actor id→name) — one
      // call per report, cached, reused across every death in that report. It
      // resolves EVERY ability in the window (the windowed damage table leaves
      // gaps) and names the healers/bosses behind each event.
      const abilityNames = new Map<number, string>();
      const actorNames = new Map<number, string>();
      const mdKey = `wcl-md:${input.reportCode}`;
      let mdJson: { a: [number, string][]; n: [number, string][] } | null = null;
      try {
        const cachedMd = await redis.get(mdKey);
        if (cachedMd) mdJson = JSON.parse(cachedMd);
      } catch {
        /* fall through to fetch */
      }
      if (!mdJson) {
        const mdRes = await wcl.query({
          query: REPORT_MASTERDATA_QUERY,
          variables: { code: input.reportCode },
          schema: reportMasterDataResponseSchema,
          estimatedPoints: 4,
        });
        const md = mdRes.reportData?.report?.masterData;
        mdJson = {
          a: (md?.abilities ?? [])
            .filter((x) => x.gameID != null && x.name != null)
            .map((x) => [x.gameID as number, x.name as string]),
          n: (md?.actors ?? [])
            .filter((x) => x.id != null && x.name != null)
            .map((x) => [x.id as number, x.name as string]),
        };
        try {
          await redis.set(
            mdKey,
            JSON.stringify(mdJson),
            "EX",
            report.frozen ? 7 * 24 * 60 * 60 : 3600,
          );
        } catch {
          /* best-effort */
        }
      }
      for (const [id, name] of mdJson.a) abilityNames.set(id, name);
      for (const [id, name] of mdJson.n) actorNames.set(id, name);

      // Three small windowed calls (one fight, ~10s, one actor).
      const [dmgRes, castRes, healRes] = await Promise.all([
        wcl.query({
          query: DEATH_DAMAGE_TAKEN_QUERY,
          variables: { ...vars, playerID: input.targetActorId },
          schema: reportDeathsResponseSchema,
          estimatedPoints: 6,
        }),
        wcl.query({
          query: DEATH_PLAYER_CASTS_QUERY,
          variables: { ...vars, sourceID: input.targetActorId },
          schema: reportDeathsResponseSchema,
          estimatedPoints: 4,
        }),
        wcl
          .query({
            query: DEATH_HEALING_TAKEN_QUERY,
            variables: { ...vars, targetID: input.targetActorId },
            schema: reportDeathsResponseSchema,
            estimatedPoints: 4,
          })
          .catch(() => null), // healing is best-effort
      ]);

      const result = buildDeathContext(
        relMs,
        parseDamageTakenEvents(dmgRes.reportData?.report?.events?.data),
        parseCastWindow(castRes.reportData?.report?.events?.data),
        parseHealWindow(healRes?.reportData?.report?.events?.data),
        abilityNames,
        {
          windowMs: WINDOW_MS,
          killingAbilityId: death?.killingAbilityGameId ?? null,
          killingAbilityName: death?.killingAbilityName ?? null,
          actorNames,
        },
      );

      try {
        // A frozen report's window never changes → cache a week; live → 10 min.
        await redis.set(
          cacheKey,
          JSON.stringify(result),
          "EX",
          report.frozen ? 7 * 24 * 60 * 60 : 600,
        );
      } catch {
        /* cache write best-effort */
      }
      return result;
    }),

  /**
   * Attendance Ledger — OBSERVED raid presence (RaidNightObservation, fed by
   * the in-game addon) merged with first-party calendar SIGNUPS (EventSignup).
   * Observers are unioned and observations clustered into nights (8h gap); a
   * night is matched to a calendar event (for its scheduled start + signups)
   * when one starts within 4h. Only OBSERVED nights count toward the
   * denominators. Scoring lives in @/lib/attendance-ledger; presence names are
   * resolved to the team roster by normalized name.
   */
  attendanceLedger: publicProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const { guildId } = await assertTeamReadAccess(ctx, input.raidTeamId);

      const team = await ctx.db.raidTeam.findUnique({
        where: { id: input.raidTeamId },
        select: {
          memberships: {
            where: { isActive: true },
            select: {
              characterId: true,
              character: {
                select: { name: true, classId: true, realmSlug: true },
              },
            },
          },
        },
      });
      const memberMeta = new Map(
        (team?.memberships ?? []).map((m) => [
          m.characterId,
          { name: m.character.name, classId: m.character.classId },
        ]),
      );
      const teamCharacterIds = [...memberMeta.keys()];
      // Resolve observed raid names → characterId. GetRaidRosterInfo gives
      // "Name" same-realm or "Name-Realm" cross-realm, so key on BOTH name and
      // name+realm; a name shared by two team members on different realms is
      // marked ambiguous (null) so it's never mis-attributed.
      const byNameRealm = new Map<string, string>();
      const byNameOnly = new Map<string, string | null>();
      for (const m of team?.memberships ?? []) {
        const nk = normalizeKey(m.character.name);
        byNameRealm.set(`${nk}|${normalizeKey(m.character.realmSlug)}`, m.characterId);
        byNameOnly.set(nk, byNameOnly.has(nk) ? null : m.characterId);
      }
      const resolveName = (rawName: string): string | null => {
        const dash = rawName.indexOf("-");
        const nk = normalizeKey(dash >= 0 ? rawName.slice(0, dash) : rawName);
        if (dash >= 0) {
          const rk = normalizeKey(rawName.slice(dash + 1));
          const exact = byNameRealm.get(`${nk}|${rk}`);
          if (exact) return exact;
        }
        return byNameOnly.get(nk) ?? null; // null = absent OR ambiguous
      };

      type NightMeta = {
        key: string;
        startedAt: number; // ms
        endedAt: number; // ms
        instanceName: string | null;
        difficulty: string | null;
        eventId: string | null;
        scheduled: boolean;
      };
      const memberMetaObj: Record<
        string,
        { name: string; classId: number | null }
      > = {};
      for (const [cid, meta] of memberMeta) memberMetaObj[cid] = meta;

      const empty = {
        nights: [] as NightMeta[],
        members: [] as Array<{
          characterId: string;
          states: NightState[];
          observedNights: number;
          present: number;
          late: number;
          leftEarly: number;
          absent: number;
          attendancePct: number | null;
        }>,
        memberMeta: memberMetaObj,
        signupsByNight: {} as Record<string, Record<string, string>>,
        observerCount: 0,
        hasObservations: false,
      };
      if (teamCharacterIds.length === 0) return empty;

      const since = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000);
      const obs = await ctx.db.raidNightObservation.findMany({
        where: { guildId, startedAt: { gte: since } },
        orderBy: { startedAt: "asc" },
        select: {
          observerCharacterId: true,
          startedAt: true,
          endedAt: true,
          instanceName: true,
          difficulty: true,
          members: true,
        },
      });
      if (obs.length === 0) return empty;
      const observerCount = new Set(obs.map((o) => o.observerCharacterId)).size;

      // Resolve an observation's members JSON to team presence rows.
      const resolvePresent = (
        raw: unknown,
      ): Array<{ characterId: string; firstSeen: number; lastSeen: number }> => {
        const arr = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
        const out: Array<{
          characterId: string;
          firstSeen: number;
          lastSeen: number;
        }> = [];
        for (const m of arr) {
          const name = typeof m.name === "string" ? m.name : null;
          if (!name) continue;
          const cid = resolveName(name);
          if (!cid) continue;
          const fs = typeof m.firstSeen === "number" ? m.firstSeen : null;
          const ls = typeof m.lastSeen === "number" ? m.lastSeen : fs;
          if (fs == null || ls == null) continue;
          out.push({ characterId: cid, firstSeen: fs, lastSeen: ls });
        }
        return out;
      };

      // Cluster observations into nights by time proximity, sharing one key
      // across observers so mergeObservers unions their presence.
      const GAP_MS = 8 * 60 * 60 * 1000;
      const nightInfo = new Map<
        string,
        { instanceName: string | null; difficulty: string | null }
      >();
      const observerInputs: Array<{
        key: string;
        startedAt: number;
        endedAt: number;
        present: Array<{ characterId: string; firstSeen: number; lastSeen: number }>;
      }> = [];
      let currentKey: string | null = null;
      let clusterEnd = 0;
      for (const o of obs) {
        const st = o.startedAt.getTime();
        if (currentKey == null || st - clusterEnd > GAP_MS) {
          currentKey = String(st);
        }
        clusterEnd = Math.max(clusterEnd, o.endedAt.getTime());
        if (!nightInfo.has(currentKey)) {
          nightInfo.set(currentKey, {
            instanceName: o.instanceName,
            difficulty: o.difficulty,
          });
        }
        observerInputs.push({
          key: currentKey,
          startedAt: Math.floor(st / 1000),
          endedAt: Math.floor(o.endedAt.getTime() / 1000),
          present: resolvePresent(o.members),
        });
      }

      const nights = mergeObservers(observerInputs);

      // Match each night to a calendar event (scheduled start + signups).
      const events = await ctx.db.raidEvent.findMany({
        where: {
          raidTeamId: input.raidTeamId,
          startsAt: {
            gte: new Date(since.getTime() - 6 * 60 * 60 * 1000),
            lte: new Date(),
          },
        },
        select: {
          id: true,
          startsAt: true,
          signups: {
            where: { characterId: { in: teamCharacterIds } },
            select: { characterId: true, state: true },
          },
        },
      });
      const MATCH_MS = 4 * 60 * 60 * 1000;
      const signupsByNight: Record<string, Record<string, string>> = {};
      const nightMeta: NightMeta[] = nights.map((n) => {
        const startMs = n.startedAt * 1000;
        let best: (typeof events)[number] | null = null;
        let bestDelta = MATCH_MS + 1;
        for (const e of events) {
          const d = Math.abs(e.startsAt.getTime() - startMs);
          if (d < bestDelta) {
            best = e;
            bestDelta = d;
          }
        }
        const info = nightInfo.get(n.key);
        if (best) {
          // Use the SCHEDULED start as the late-threshold anchor.
          n.startedAt = Math.floor(best.startsAt.getTime() / 1000);
          const sm: Record<string, string> = {};
          for (const s of best.signups) sm[s.characterId] = s.state;
          signupsByNight[n.key] = sm;
        }
        return {
          key: n.key,
          startedAt: n.startedAt * 1000,
          endedAt: n.endedAt * 1000,
          instanceName: info?.instanceName ?? null,
          difficulty: info?.difficulty ?? null,
          eventId: best?.id ?? null,
          scheduled: best != null,
        };
      });

      const attendance = computeAttendance(nights, teamCharacterIds).map((a) => ({
        characterId: a.characterId,
        states: a.states,
        observedNights: a.observedNights,
        present: a.present,
        late: a.late,
        leftEarly: a.leftEarly,
        absent: a.absent,
        attendancePct: a.attendancePct,
      }));
      // Surface the most-attended members first; absentees sink.
      attendance.sort(
        (x, y) => (y.attendancePct ?? -1) - (x.attendancePct ?? -1),
      );

      return {
        nights: nightMeta,
        members: attendance,
        memberMeta: memberMetaObj,
        signupsByNight,
        observerCount,
        hasObservations: true,
      };
    }),

  /**
   * Learning Curve — per-player mechanic learning rate on a boss, from the
   * verified WCL deaths layer: across a boss's chronological wipe pulls, does
   * each player STOP dying to it? Early-vs-late-half death rate + survival
   * time, TEAM-RELATIVE (cancels the progression-depth confounder). Reuses
   * firstDeathLedger's source resolution + ≥2-roster gate + observed gate. The
   * avoidable-damage enrichment (addon C_DamageMeter / WCL DamageTaken) plugs
   * into the per-pull `avoidableDamage` slot when present. Math lives in
   * @/lib/learning-curve.
   */
  learningCurve: publicProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertTeamReadAccess(ctx, input.raidTeamId);

      const team = await ctx.db.raidTeam.findUnique({
        where: { id: input.raidTeamId },
        select: {
          wclGuildId: true,
          wclGuildName: true,
          guild: { select: { id: true, wclGuildId: true, name: true } },
          memberships: {
            where: { isActive: true },
            select: {
              characterId: true,
              character: { select: { name: true, classId: true } },
            },
          },
        },
      });
      const guildId = team?.guild.id ?? null;
      const effectiveSource = team?.wclGuildId ?? team?.guild.wclGuildId ?? null;
      const source = {
        wclGuildId: effectiveSource,
        name:
          team?.wclGuildId != null
            ? (team.wclGuildName ?? `WCL guild #${team.wclGuildId}`)
            : (team?.guild.name ?? "Guild logs"),
        isOverride: team?.wclGuildId != null,
      };
      const memberMeta = new Map(
        (team?.memberships ?? []).map((m) => [
          m.characterId,
          { name: m.character.name, classId: m.character.classId },
        ]),
      );
      const teamCharacterIds = [...memberMeta.keys()];
      const members: Record<string, { name: string; classId: number | null }> =
        {};
      for (const [cid, meta] of memberMeta) members[cid] = meta;

      type LearnEncounter = {
        encounterId: number;
        difficulty: number;
        wipePulls: number;
        members: MemberLearning[];
      };
      const empty = {
        encounters: [] as LearnEncounter[],
        encounterNames: {} as Record<number, string>,
        members,
        source,
      };
      if (!guildId || teamCharacterIds.length === 0) return empty;

      const sourceClauses: Array<{ wclGuildId: number | null }> = [
        { wclGuildId: null },
      ];
      if (effectiveSource != null) {
        sourceClauses.push({ wclGuildId: effectiveSource });
      }
      const since = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000);
      const reports = await ctx.db.wclReport.findMany({
        where: {
          guildId,
          startTime: { gte: since },
          revision: { gte: 0 },
          OR: sourceClauses,
        },
        select: { code: true, wclGuildId: true },
      });
      if (reports.length === 0) return empty;
      const reportCodes = reports.map((r) => r.code);
      const sourcedCodes = new Set(
        reports.filter((r) => r.wclGuildId != null).map((r) => r.code),
      );

      const [fightRows, deathRows, actorRows, observedReports] =
        await Promise.all([
          ctx.db.wclFight.findMany({
            where: { reportCode: { in: reportCodes }, kill: false },
            select: {
              reportCode: true,
              fightId: true,
              encounterId: true,
              difficulty: true,
              startAt: true,
              friendlyPlayerIds: true,
            },
          }),
          ctx.db.wclFightDeath.findMany({
            where: {
              reportCode: { in: reportCodes },
              kill: false,
              characterId: { in: teamCharacterIds },
            },
            select: {
              reportCode: true,
              fightId: true,
              characterId: true,
              deathAt: true,
              deathOrder: true,
            },
          }),
          ctx.db.wclReportActor.findMany({
            where: {
              reportCode: { in: reportCodes },
              characterId: { in: teamCharacterIds },
            },
            select: { reportCode: true, actorId: true, characterId: true },
          }),
          ctx.db.wclFightDeath.findMany({
            where: { reportCode: { in: reportCodes } },
            distinct: ["reportCode"],
            select: { reportCode: true },
          }),
        ]);
      const observedReportCodes = new Set(
        observedReports.map((r) => r.reportCode),
      );

      const actorMapByReport = new Map<string, Map<number, string>>();
      for (const a of actorRows) {
        if (!a.characterId) continue;
        let m = actorMapByReport.get(a.reportCode);
        if (!m) {
          m = new Map();
          actorMapByReport.set(a.reportCode, m);
        }
        m.set(a.actorId, a.characterId);
      }
      // Per (report|fight|character): their first death TIME (survival depth)
      // + their best (lowest) death ORDER (were they among the first to fall).
      const firstDeath = new Map<string, { at: number; order: number }>();
      for (const d of deathRows) {
        if (!d.characterId) continue;
        const key = `${d.reportCode}|${d.fightId}|${d.characterId}`;
        const at = d.deathAt.getTime();
        const prev = firstDeath.get(key);
        if (prev == null) {
          firstDeath.set(key, { at, order: d.deathOrder });
        } else {
          if (at < prev.at) prev.at = at;
          if (d.deathOrder < prev.order) prev.order = d.deathOrder;
        }
      }

      // Gated, observed wipe fights grouped per encounter|difficulty, ordered.
      type GFight = {
        reportCode: string;
        fightId: number;
        startMs: number;
        present: string[];
      };
      const byEnc = new Map<string, GFight[]>();
      for (const f of fightRows) {
        if (!observedReportCodes.has(f.reportCode)) continue; // need death data
        const actorMap = actorMapByReport.get(f.reportCode);
        const present = new Set<string>();
        if (actorMap) {
          for (const aid of f.friendlyPlayerIds) {
            const cid = actorMap.get(aid);
            if (cid) present.add(cid);
          }
        }
        if (!sourcedCodes.has(f.reportCode) && present.size < 2) continue;
        const k = `${f.encounterId}|${f.difficulty}`;
        (byEnc.get(k) ?? byEnc.set(k, []).get(k)!).push({
          reportCode: f.reportCode,
          fightId: f.fightId,
          startMs: f.startAt.getTime(),
          present: [...present],
        });
      }

      // Avoidable-damage enrichment (ingested per early/late bucket by the GRS
      // sweep): the team's per-(encounter,difficulty,character) early/late
      // totals from the boss's killing abilities. Null until the sweep runs.
      const avoidRows = await ctx.db.wclAvoidableDamage.findMany({
        where: { guildId, characterId: { in: teamCharacterIds } },
        select: {
          encounterId: true,
          difficulty: true,
          bucket: true,
          characterId: true,
          total: true,
        },
      });
      const avoidMap = new Map<string, { early: number; late: number }>();
      for (const a of avoidRows) {
        const key = `${a.encounterId}|${a.difficulty}|${a.characterId}`;
        const e = avoidMap.get(key) ?? { early: 0, late: 0 };
        const v = Number(a.total);
        if (a.bucket === 0) e.early += v;
        else e.late += v;
        avoidMap.set(key, e);
      }

      const encounters: LearnEncounter[] = [];
      for (const [k, gfights] of byEnc) {
        gfights.sort((a, b) => a.startMs - b.startMs); // chronological
        const [encStr, diffStr] = k.split("|");
        const encounterId = Number(encStr);
        const difficulty = Number(diffStr);
        // Per member: their pull sequence over the wipes they were present for.
        const pullsByMember = new Map<string, LearnPull[]>();
        for (const f of gfights) {
          for (const cid of f.present) {
            const fd = firstDeath.get(`${f.reportCode}|${f.fightId}|${cid}`);
            (pullsByMember.get(cid) ?? pullsByMember.set(cid, []).get(cid)!).push({
              // "died" = died EARLY (order ≤ 2): not saturated like raw deaths.
              died: fd != null && fd.order <= 2,
              msIntoPull: fd != null ? Math.max(0, fd.at - f.startMs) : null,
            });
          }
        }
        const learned = computeLearning(pullsByMember);
        if (learned.length === 0) continue;
        // Inject the avoidable-damage enrichment (early/late bucket totals).
        for (const m of learned) {
          const a = avoidMap.get(`${encounterId}|${difficulty}|${m.characterId}`);
          if (a) {
            m.earlyAvoidable = a.early;
            m.lateAvoidable = a.late;
          }
        }
        // Coaching candidates first: flagged, then slowest learners.
        learned.sort(
          (a, b) =>
            Number(b.flagged) - Number(a.flagged) ||
            (b.relativeRatio ?? 0) - (a.relativeRatio ?? 0),
        );
        encounters.push({
          encounterId,
          difficulty,
          wipePulls: gfights.length,
          members: learned,
        });
      }
      encounters.sort((a, b) => b.wipePulls - a.wipePulls);

      const encIds = [...new Set(encounters.map((e) => e.encounterId))];
      const nameRows = encIds.length
        ? await ctx.db.wclParseSnapshot.findMany({
            where: {
              encounterId: { in: encIds },
              encounterName: { not: null },
            },
            distinct: ["encounterId"],
            select: { encounterId: true, encounterName: true },
          })
        : [];
      const encounterNames: Record<number, string> = {};
      for (const n of nameRows) {
        if (n.encounterName) encounterNames[n.encounterId] = n.encounterName;
      }

      return { encounters, encounterNames, members, source };
    }),

  /**
   * Heatmap fight drill-in — one character's per-kill history on one boss
   * (date, percentile, WCL log link), from the stored parse rawPayload.ranks.
   * Lazily fetched when a parses-heatmap cell is clicked, so the heatmap's
   * own payload stays lean. Team-scoped read access.
   */
  encounterKills: publicProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        characterId: z.string().cuid(),
        encounterId: z.number().int(),
        difficulty: z.number().int(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertTeamReadAccess(ctx, input.raidTeamId);
      const empty = {
        kills: [] as Array<{ t: number; pct: number; reportCode: string | null }>,
        encounterName: null as string | null,
      };
      // The character must be on this team (don't leak arbitrary characters).
      const membership = await ctx.db.raidTeamMembership.findFirst({
        where: { raidTeamId: input.raidTeamId, characterId: input.characterId },
        select: { id: true },
      });
      if (!membership) return empty;
      const snap = await ctx.db.wclParseSnapshot.findFirst({
        where: {
          characterId: input.characterId,
          encounterId: input.encounterId,
          difficulty: input.difficulty,
        },
        orderBy: { capturedAt: "desc" },
        select: { rawPayload: true, encounterName: true },
      });
      if (!snap) return empty;
      return {
        kills: extractKillDetail(snap.rawPayload),
        encounterName: snap.encounterName ?? null,
      };
    }),

  /**
   * Bench Equity — per-boss pull participation: who pulls vs who sits. Reads
   * the GRS fight rows (friendlyPlayers per pull) + the same source resolution
   * and ≥2-roster participation gate as firstDeathLedger. Per (encounter,
   * difficulty): total pulls + each member's pulls-present + kill presence,
   * plus an overall participation rate. Zero WCL spend at request time.
   */
  benchEquity: publicProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertTeamReadAccess(ctx, input.raidTeamId);

      const team = await ctx.db.raidTeam.findUnique({
        where: { id: input.raidTeamId },
        select: {
          wclGuildId: true,
          wclGuildName: true,
          guild: { select: { id: true, wclGuildId: true, name: true } },
          memberships: {
            where: { isActive: true },
            select: {
              characterId: true,
              character: { select: { name: true, classId: true } },
            },
          },
        },
      });
      const guildId = team?.guild.id ?? null;
      const effectiveSource = team?.wclGuildId ?? team?.guild.wclGuildId ?? null;
      const source = {
        wclGuildId: effectiveSource,
        name:
          team?.wclGuildId != null
            ? (team.wclGuildName ?? `WCL guild #${team.wclGuildId}`)
            : (team?.guild.name ?? "Guild logs"),
        isOverride: team?.wclGuildId != null,
      };
      const memberMeta = new Map(
        (team?.memberships ?? []).map((m) => [
          m.characterId,
          { name: m.character.name, classId: m.character.classId },
        ]),
      );
      const teamCharacterIds = [...memberMeta.keys()];
      const memberMetaObj: Record<
        string,
        { name: string; classId: number | null }
      > = {};
      for (const [cid, meta] of memberMeta) memberMetaObj[cid] = meta;

      type BenchEnc = {
        encounterId: number;
        difficulty: number;
        totalPulls: number;
        killPulls: number;
      };
      type BenchMember = {
        characterId: string;
        pullsPresent: number;
        pullPct: number;
        byEnc: Record<string, { pullsIn: number; killPresent: boolean }>;
      };
      const empty = {
        totalPulls: 0,
        encounters: [] as BenchEnc[],
        members: [] as BenchMember[],
        memberMeta: memberMetaObj,
        encounterNames: {} as Record<number, string>,
        source,
      };
      if (!guildId || teamCharacterIds.length === 0) return empty;

      const sourceClauses: Array<{ wclGuildId: number | null }> = [
        { wclGuildId: null },
      ];
      if (effectiveSource != null) {
        sourceClauses.push({ wclGuildId: effectiveSource });
      }
      const since = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000);
      const reports = await ctx.db.wclReport.findMany({
        where: {
          guildId,
          startTime: { gte: since },
          revision: { gte: 0 },
          OR: sourceClauses,
        },
        select: { code: true, wclGuildId: true },
      });
      if (reports.length === 0) return empty;
      const reportCodes = reports.map((r) => r.code);
      const sourcedCodes = new Set(
        reports.filter((r) => r.wclGuildId != null).map((r) => r.code),
      );

      const [fightRows, actorRows] = await Promise.all([
        ctx.db.wclFight.findMany({
          where: { reportCode: { in: reportCodes } },
          select: {
            reportCode: true,
            encounterId: true,
            difficulty: true,
            kill: true,
            startAt: true,
            friendlyPlayerIds: true,
          },
        }),
        ctx.db.wclReportActor.findMany({
          where: {
            reportCode: { in: reportCodes },
            characterId: { in: teamCharacterIds },
          },
          select: { reportCode: true, actorId: true, characterId: true },
        }),
      ]);
      const actorMapByReport = new Map<string, Map<number, string>>();
      for (const a of actorRows) {
        if (!a.characterId) continue;
        let m = actorMapByReport.get(a.reportCode);
        if (!m) {
          m = new Map();
          actorMapByReport.set(a.reportCode, m);
        }
        m.set(a.actorId, a.characterId);
      }

      const encTotals = new Map<string, BenchEnc>();
      const partByEncChar = new Map<
        string,
        { pullsIn: number; killPresent: boolean }
      >();
      const pullsPresent = new Map<string, number>();
      let totalPulls = 0;
      // Swept (non-sourced, wclGuildId=null) reports are pug / cross-guild logs
      // surfaced via a member's personal parse ranks. Counting them when only
      // 1-2 roster characters were present lets one raider's pug pulls (e.g.
      // Crown of the Cosmos) balloon far above the team's own logs (the reported
      // "101 vs max 17" bug). Require a substantial share of the roster to be
      // present before a swept fight counts toward team bench-equity. Sourced
      // (guild-own) logs are never gated. Threshold is heuristic — tune if a
      // small/bench-heavy team loses legitimate personally-logged nights.
      const sweptMinPresent = Math.max(
        2,
        Math.ceil(teamCharacterIds.length * 0.5),
      );
      // Dedup physical pulls across report copies. The SAME pull is frequently
      // logged under multiple report codes (the guild log + a member's personal
      // log), and there is no DB-level dedup (`@@unique([reportCode, fightId])`
      // only) — so counting raw WclFight rows multiplies a pull by the number of
      // copies it appears in. A raider present in every copy (typically the
      // owner/uploader) balloons far above teammates present only in the guild
      // log (the reported "101 vs 37" bug). Cluster fights by (encounter|
      // difficulty) + startAt within a small tolerance — the same physical pull
      // shares an absolute startAt across copies (±clock skew), while distinct
      // pulls are far apart — then UNION the resolved roster across the copies
      // (a member present in ANY copy counts once, which also repairs a guild
      // log that under-captured friendlies) and treat the pull as sourced if ANY
      // copy is sourced. Count each physical pull exactly once.
      const PULL_MERGE_MS = 5000;
      type PhysPull = {
        encounterId: number;
        difficulty: number;
        kill: boolean;
        sourced: boolean;
        present: Set<string>;
      };
      const fightsByEncDiff = new Map<string, typeof fightRows>();
      for (const f of fightRows) {
        const k = `${f.encounterId}|${f.difficulty}`;
        let arr = fightsByEncDiff.get(k);
        if (!arr) fightsByEncDiff.set(k, (arr = []));
        arr.push(f);
      }
      const physPulls: PhysPull[] = [];
      for (const fs of fightsByEncDiff.values()) {
        fs.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
        let cluster: PhysPull | null = null;
        let clusterTime = Number.NEGATIVE_INFINITY;
        for (const f of fs) {
          const t = f.startAt.getTime();
          if (!cluster || t - clusterTime > PULL_MERGE_MS) {
            cluster = {
              encounterId: f.encounterId,
              difficulty: f.difficulty,
              kill: false,
              sourced: false,
              present: new Set<string>(),
            };
            physPulls.push(cluster);
          }
          clusterTime = t;
          cluster.kill ||= f.kill;
          cluster.sourced ||= sourcedCodes.has(f.reportCode);
          const actorMap = actorMapByReport.get(f.reportCode);
          if (actorMap) {
            for (const aid of f.friendlyPlayerIds) {
              const cid = actorMap.get(aid);
              if (cid) cluster.present.add(cid);
            }
          }
        }
      }

      for (const pp of physPulls) {
        // Swept (no sourced copy) pulls still need a real share of the roster
        // present, or one raider's pug log inflates the boss's totals.
        if (!pp.sourced && pp.present.size < sweptMinPresent) continue;
        const key = `${pp.encounterId}|${pp.difficulty}`;
        const enc = encTotals.get(key) ?? {
          encounterId: pp.encounterId,
          difficulty: pp.difficulty,
          totalPulls: 0,
          killPulls: 0,
        };
        enc.totalPulls++;
        if (pp.kill) enc.killPulls++;
        encTotals.set(key, enc);
        totalPulls++;
        for (const cid of pp.present) {
          pullsPresent.set(cid, (pullsPresent.get(cid) ?? 0) + 1);
          const ek = `${key}|${cid}`;
          const p = partByEncChar.get(ek) ?? { pullsIn: 0, killPresent: false };
          p.pullsIn++;
          if (pp.kill) p.killPresent = true;
          partByEncChar.set(ek, p);
        }
      }
      if (totalPulls === 0) return empty;

      const encounters = [...encTotals.values()].sort(
        (a, b) => b.totalPulls - a.totalPulls,
      );
      const members: BenchMember[] = teamCharacterIds
        .map((cid) => {
          const present = pullsPresent.get(cid) ?? 0;
          const byEnc: Record<
            string,
            { pullsIn: number; killPresent: boolean }
          > = {};
          for (const e of encounters) {
            const ek = `${e.encounterId}|${e.difficulty}`;
            const p = partByEncChar.get(`${ek}|${cid}`);
            if (p) byEnc[ek] = p;
          }
          return {
            characterId: cid,
            pullsPresent: present,
            pullPct: (present / totalPulls) * 100,
            byEnc,
          };
        })
        // Only members who appear in at least one pull (drop never-seen alts).
        .filter((m) => m.pullsPresent > 0)
        .sort((a, b) => b.pullPct - a.pullPct);

      const encIds = [...new Set(encounters.map((e) => e.encounterId))];
      const nameRows = encIds.length
        ? await ctx.db.wclParseSnapshot.findMany({
            where: { encounterId: { in: encIds }, encounterName: { not: null } },
            distinct: ["encounterId"],
            select: { encounterId: true, encounterName: true },
          })
        : [];
      const encounterNames: Record<number, string> = {};
      for (const n of nameRows) {
        if (n.encounterName) encounterNames[n.encounterId] = n.encounterName;
      }

      return {
        totalPulls,
        encounters,
        members,
        memberMeta: memberMetaObj,
        encounterNames,
        source,
      };
    }),

  /**
   * Brez Economy — battle-rez (combat-resurrection) usage from the deaths
   * layer's rez fields (set by the GRS rez pass). Per boss: rezzes spent on
   * wipes + rezzes/pull, a "success" rate (rezzed and didn't re-die in the
   * pull vs wasted on a doomed pull), who PROVIDES the brezzes (rezzer
   * leaderboard), and who needs them most. Same source + ≥2-roster gate as
   * firstDeathLedger. Zero WCL spend at request time.
   */
  brezEconomy: publicProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertTeamReadAccess(ctx, input.raidTeamId);

      const team = await ctx.db.raidTeam.findUnique({
        where: { id: input.raidTeamId },
        select: {
          wclGuildId: true,
          wclGuildName: true,
          guild: { select: { id: true, wclGuildId: true, name: true } },
          memberships: {
            where: { isActive: true },
            select: {
              characterId: true,
              character: { select: { name: true, classId: true } },
            },
          },
        },
      });
      const guildId = team?.guild.id ?? null;
      const effectiveSource = team?.wclGuildId ?? team?.guild.wclGuildId ?? null;
      const source = {
        wclGuildId: effectiveSource,
        name:
          team?.wclGuildId != null
            ? (team.wclGuildName ?? `WCL guild #${team.wclGuildId}`)
            : (team?.guild.name ?? "Guild logs"),
        isOverride: team?.wclGuildId != null,
      };
      const memberMeta = new Map(
        (team?.memberships ?? []).map((m) => [
          m.characterId,
          { name: m.character.name, classId: m.character.classId },
        ]),
      );
      const teamCharacterIds = [...memberMeta.keys()];
      const memberMetaObj: Record<
        string,
        { name: string; classId: number | null }
      > = {};
      for (const [cid, meta] of memberMeta) memberMetaObj[cid] = meta;

      type BrezEnc = {
        encounterId: number;
        difficulty: number;
        wipePulls: number;
        rezzes: number;
        successful: number;
        rezzesPerPull: number;
      };
      const empty = {
        encounters: [] as BrezEnc[],
        rezzers: [] as Array<{ characterId: string; count: number }>,
        rezzed: [] as Array<{ characterId: string; count: number }>,
        totalRezzes: 0,
        successRate: null as number | null,
        memberMeta: memberMetaObj,
        encounterNames: {} as Record<number, string>,
        source,
      };
      if (!guildId || teamCharacterIds.length === 0) return empty;

      const sourceClauses: Array<{ wclGuildId: number | null }> = [
        { wclGuildId: null },
      ];
      if (effectiveSource != null) {
        sourceClauses.push({ wclGuildId: effectiveSource });
      }
      const since = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000);
      const reports = await ctx.db.wclReport.findMany({
        where: {
          guildId,
          startTime: { gte: since },
          revision: { gte: 0 },
          OR: sourceClauses,
        },
        select: { code: true, wclGuildId: true },
      });
      if (reports.length === 0) return empty;
      const reportCodes = reports.map((r) => r.code);
      const sourcedCodes = new Set(
        reports.filter((r) => r.wclGuildId != null).map((r) => r.code),
      );

      const [fightRows, deathRows, actorRows] = await Promise.all([
        ctx.db.wclFight.findMany({
          where: { reportCode: { in: reportCodes }, kill: false },
          select: {
            reportCode: true,
            fightId: true,
            friendlyPlayerIds: true,
          },
        }),
        ctx.db.wclFightDeath.findMany({
          where: { reportCode: { in: reportCodes }, kill: false },
          select: {
            reportCode: true,
            fightId: true,
            encounterId: true,
            difficulty: true,
            characterId: true,
            targetActorId: true,
            deathAt: true,
            rezzedAt: true,
            rezzerActorId: true,
          },
        }),
        ctx.db.wclReportActor.findMany({
          where: {
            reportCode: { in: reportCodes },
            characterId: { in: teamCharacterIds },
          },
          select: { reportCode: true, actorId: true, characterId: true },
        }),
      ]);
      const actorMapByReport = new Map<string, Map<number, string>>();
      for (const a of actorRows) {
        if (!a.characterId) continue;
        (actorMapByReport.get(a.reportCode) ??
          actorMapByReport
            .set(a.reportCode, new Map())
            .get(a.reportCode)!).set(a.actorId, a.characterId);
      }

      // Gate: which wipe fights count for this team (sourced, or ≥2 roster).
      const gated = new Set<string>();
      for (const f of fightRows) {
        if (sourcedCodes.has(f.reportCode)) {
          gated.add(`${f.reportCode}|${f.fightId}`);
          continue;
        }
        const amap = actorMapByReport.get(f.reportCode);
        if (!amap) continue;
        let n = 0;
        for (const aid of f.friendlyPlayerIds) {
          if (amap.has(aid)) {
            n++;
            if (n >= 2) {
              gated.add(`${f.reportCode}|${f.fightId}`);
              break;
            }
          }
        }
      }

      // Group deaths per (report|fight|target) to find the LAST death — a
      // rez on a non-last death means the target re-died (wasted); a rez on
      // the last death means they were brought back and survived (success).
      const seq = new Map<string, typeof deathRows>();
      for (const d of deathRows) {
        if (!gated.has(`${d.reportCode}|${d.fightId}`)) continue;
        const k = `${d.reportCode}|${d.fightId}|${d.targetActorId}`;
        (seq.get(k) ?? seq.set(k, []).get(k)!).push(d);
      }

      const encMap = new Map<string, BrezEnc>();
      const wipeFightSet = new Map<string, Set<string>>(); // encKey → fight keys
      const rezzerCount = new Map<string, number>();
      const rezzedCount = new Map<string, number>();
      let totalRezzes = 0;
      let successful = 0;
      for (const [, ds] of seq) {
        ds.sort((a, b) => a.deathAt.getTime() - b.deathAt.getTime());
        ds.forEach((d, i) => {
          const encKey = `${d.encounterId}|${d.difficulty}`;
          const enc = encMap.get(encKey) ?? {
            encounterId: d.encounterId,
            difficulty: d.difficulty,
            wipePulls: 0,
            rezzes: 0,
            successful: 0,
            rezzesPerPull: 0,
          };
          // track distinct wipe fights per encounter
          const wf = wipeFightSet.get(encKey) ?? new Set<string>();
          wf.add(`${d.reportCode}|${d.fightId}`);
          wipeFightSet.set(encKey, wf);
          if (d.rezzedAt != null) {
            enc.rezzes++;
            totalRezzes++;
            const isLast = i === ds.length - 1; // no later death → survived
            if (isLast) {
              enc.successful++;
              successful++;
            }
            // who provided + who received
            if (d.rezzerActorId != null) {
              const cid = actorMapByReport
                .get(d.reportCode)
                ?.get(d.rezzerActorId);
              if (cid) rezzerCount.set(cid, (rezzerCount.get(cid) ?? 0) + 1);
            }
            if (d.characterId)
              rezzedCount.set(
                d.characterId,
                (rezzedCount.get(d.characterId) ?? 0) + 1,
              );
          }
          encMap.set(encKey, enc);
        });
      }
      for (const [k, enc] of encMap) {
        enc.wipePulls = wipeFightSet.get(k)?.size ?? 0;
        enc.rezzesPerPull = enc.wipePulls > 0 ? enc.rezzes / enc.wipePulls : 0;
      }

      const encounters = [...encMap.values()]
        .filter((e) => e.rezzes > 0)
        .sort((a, b) => b.rezzes - a.rezzes);
      const rezzers = [...rezzerCount.entries()]
        .map(([characterId, count]) => ({ characterId, count }))
        .sort((a, b) => b.count - a.count);
      const rezzed = [...rezzedCount.entries()]
        .map(([characterId, count]) => ({ characterId, count }))
        .sort((a, b) => b.count - a.count);

      const encIds = [...new Set(encounters.map((e) => e.encounterId))];
      const nameRows = encIds.length
        ? await ctx.db.wclParseSnapshot.findMany({
            where: { encounterId: { in: encIds }, encounterName: { not: null } },
            distinct: ["encounterId"],
            select: { encounterId: true, encounterName: true },
          })
        : [];
      const encounterNames: Record<number, string> = {};
      for (const n of nameRows) {
        if (n.encounterName) encounterNames[n.encounterId] = n.encounterName;
      }

      return {
        encounters,
        rezzers,
        rezzed,
        totalRezzes,
        successRate: totalRezzes > 0 ? (successful / totalRezzes) * 100 : null,
        memberMeta: memberMetaObj,
        encounterNames,
        source,
      };
    }),

  /**
   * Engagement Pulse — characters × raid-weeks activity heatmap read from
   * the VaultSnapshot weekly ledger (one row per character per raid week,
   * written by Tier A but never read longitudinally until now), plus a
   * multi-signal churn watchlist (activity decay + login recency + season-
   * over-season M+ + guild-roster absences).
   *
   * Semantics contract (see src/lib/engagement-pulse.ts): a missing week row
   * is UNKNOWN, never inactive; the in-progress week is excluded from all
   * baselines; a member is watchlisted only when ≥2 independent signals
   * agree. This widget measures activity, not raid attendance.
   */
  engagementPulse: publicProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        weeks: z.number().int().min(4).max(26).default(12),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { guildId } = await assertTeamReadAccess(ctx, input.raidTeamId);

      const memberships = await ctx.db.raidTeamMembership.findMany({
        where: { raidTeamId: input.raidTeamId, isActive: true },
        include: {
          character: { select: { id: true, name: true, classId: true } },
        },
      });
      const characterIds = memberships.map((m) => m.character.id);

      const now = new Date();
      const currentWeek = weekStartUtc(now);
      const closedWeeks = closedWeekStarts(now, input.weeks);
      const oldest = closedWeeks[0] ?? currentWeek;

      if (characterIds.length === 0) {
        return {
          currentWeekStart: currentWeek,
          closedWeeks: [] as Date[],
          rosterMedian: [] as Array<number | null>,
          rosterMedianCurrent: null as number | null,
          members: [],
        };
      }

      // Week index relative to the oldest closed week. Both `oldest` and the
      // DB's weekStart come from the same Tuesday-15:00-UTC anchor, so a
      // floor-divide buckets any in-window timestamp; index === weeks count
      // is the in-progress week.
      const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
      const weekIndexOf = (d: Date): number =>
        Math.floor((d.getTime() - oldest.getTime()) / WEEK_MS);
      const cellCount = closedWeeks.length; // closed cells per member

      const [vaultRows, mplusWindowRows, parseRows, links, loginRows, latestMplus] =
        await Promise.all([
          ctx.db.vaultSnapshot.findMany({
            where: {
              characterId: { in: characterIds },
              weekStart: { gte: oldest },
            },
            select: { characterId: true, weekStart: true, slots: true },
          }),
          ctx.db.mplusSnapshot.findMany({
            where: {
              characterId: { in: characterIds },
              capturedAt: { gte: oldest },
            },
            select: {
              characterId: true,
              capturedAt: true,
              weeklyRunCount: true,
            },
          }),
          ctx.db.wclParseSnapshot.findMany({
            where: {
              characterId: { in: characterIds },
              weekPercentile: { not: null },
              reportStartTime: { gte: oldest },
            },
            select: { characterId: true, reportStartTime: true },
          }),
          ctx.db.guildCharacterLink.findMany({
            where: { characterId: { in: characterIds }, guildId },
            select: {
              characterId: true,
              lastSeenAt: true,
              consecutiveAbsences: true,
            },
          }),
          // Latest last_login_timestamp per character, extracted in SQL so we
          // don't ship each member's full ~60KB summary rawPayload to Node.
          ctx.db.$queryRaw<
            Array<{ characterId: string; lastLogin: string | null }>
          >`
            SELECT DISTINCT ON ("characterId") "characterId",
                   "rawPayload"->>'last_login_timestamp' AS "lastLogin"
            FROM "CharacterSnapshot"
            WHERE "characterId" IN (${Prisma.join(characterIds)})
              AND "source" = 'BLIZZARD'
            ORDER BY "characterId", "capturedAt" DESC
          `,
          Promise.all(
            characterIds.map((id) =>
              ctx.db.mplusSnapshot.findFirst({
                where: { characterId: id, source: "BLIZZARD" },
                orderBy: { capturedAt: "desc" },
                select: {
                  characterId: true,
                  currentRating: true,
                  previousSeasonRating: true,
                  previousSeasonSlug: true,
                },
              }),
            ),
          ),
        ]);

      // ---- index the row sets ----
      const readUnlocked = (
        slots: unknown,
        key: "raid" | "mythicPlus",
      ): number | null => {
        if (typeof slots !== "object" || slots === null) return null;
        const row = (slots as Record<string, unknown>)[key];
        if (typeof row !== "object" || row === null) return null;
        const u = (row as Record<string, unknown>).unlocked;
        return typeof u === "number" ? u : null;
      };

      type Cell = {
        score: number | null;
        raidUnlocked: number | null;
        mplusUnlocked: number | null;
        mplusRuns: number | null;
        raided: boolean;
      };
      const emptyCell = (): Cell => ({
        score: null,
        raidUnlocked: null,
        mplusUnlocked: null,
        mplusRuns: null,
        raided: false,
      });

      // characterId → per-week-index cell (0..cellCount-1 closed, cellCount = current)
      const cellMap = new Map<string, Cell[]>();
      const cellsFor = (id: string): Cell[] => {
        let c = cellMap.get(id);
        if (!c) {
          c = Array.from({ length: cellCount + 1 }, emptyCell);
          cellMap.set(id, c);
        }
        return c;
      };

      for (const v of vaultRows) {
        const idx = weekIndexOf(v.weekStart);
        if (idx < 0 || idx > cellCount) continue;
        const cell = cellsFor(v.characterId)[idx]!;
        const raid = readUnlocked(v.slots, "raid");
        const mplus = readUnlocked(v.slots, "mythicPlus");
        cell.raidUnlocked = raid;
        cell.mplusUnlocked = mplus;
        // A row exists → the week was observed; a missing half counts as 0,
        // but if BOTH halves fail to parse the row tells us nothing — keep
        // the week unknown rather than minting a false zero-activity week.
        cell.score =
          raid == null && mplus == null ? null : (raid ?? 0) + (mplus ?? 0);
      }
      for (const m of mplusWindowRows) {
        const idx = weekIndexOf(m.capturedAt);
        if (idx < 0 || idx > cellCount || m.weeklyRunCount == null) continue;
        const cell = cellsFor(m.characterId)[idx]!;
        cell.mplusRuns = Math.max(cell.mplusRuns ?? 0, m.weeklyRunCount);
      }
      for (const p of parseRows) {
        if (!p.reportStartTime) continue;
        const idx = weekIndexOf(p.reportStartTime);
        if (idx < 0 || idx > cellCount) continue;
        cellsFor(p.characterId)[idx]!.raided = true;
      }

      const linkByChar = new Map(links.map((l) => [l.characterId, l]));
      const loginByChar = new Map(
        loginRows.map((r) => [r.characterId, r.lastLogin]),
      );
      const ratingByChar = new Map(
        latestMplus
          .filter((r): r is NonNullable<typeof r> => r != null)
          .map((r) => [
            r.characterId,
            {
              current: r.currentRating != null ? Number(r.currentRating) : null,
              previous:
                r.previousSeasonRating != null
                  ? Number(r.previousSeasonRating)
                  : null,
              previousSlug: r.previousSeasonSlug,
            },
          ]),
      );

      // ---- per-member assembly ----
      const members = memberships.map((m) => {
        const id = m.character.id;
        const cells = cellsFor(id);
        const closed = cells.slice(0, cellCount);
        const current = cells[cellCount]!;
        const closedScores = closed.map((c) => c.score);

        const decay = decayFlag(closedScores);

        // Activity FREQUENCY (not hours — no public API exposes /played time):
        // the mean weekly activity score (0–6 = raid + M+ vault slots) over the
        // OBSERVED closed weeks, plus how many of those weeks the player was
        // active at all + their average M+ runs/week. An honest "how often do
        // they show up" measure; never call it playtime.
        const observedScores = closedScores.filter(
          (s): s is number => s != null,
        );
        const avgActivity =
          observedScores.length > 0
            ? observedScores.reduce((a, b) => a + b, 0) / observedScores.length
            : null;
        const activeWeeks = observedScores.filter((s) => s > 0).length;
        const observedRuns = closed
          .map((c) => c.mplusRuns)
          .filter((r): r is number => r != null);
        const avgMplusRuns =
          observedRuns.length > 0
            ? observedRuns.reduce((a, b) => a + b, 0) / observedRuns.length
            : null;

        const rawLogin = loginByChar.get(id);
        const loginMs = rawLogin != null ? Number(rawLogin) : NaN;
        const daysSinceLogin = Number.isFinite(loginMs)
          ? Math.max(0, Math.floor((now.getTime() - loginMs) / 86_400_000))
          : null;

        const rating = ratingByChar.get(id);
        const link = linkByChar.get(id);

        // Login-staleness guard: the stored last_login comes from the latest
        // CharacterSnapshot row, whose dedup hash excludes it — so the value
        // freezes for players whose gear/spec/level never change. Vault and
        // M+ snapshots DO move when they play, so demonstrated activity this
        // week or last clamps the login signal to 0 instead of letting a
        // stale timestamp claim "offline".
        const lastClosed = closed[closed.length - 1];
        const recentlyActive =
          (current.score ?? 0) > 0 ||
          (current.mplusRuns ?? 0) > 0 ||
          (lastClosed?.score ?? 0) > 0 ||
          (lastClosed?.mplusRuns ?? 0) > 0;

        const signals = {
          activity: activitySignal(decay),
          login: recentlyActive ? 0 : loginSignal(daysSinceLogin),
          mplus: mplusSignal(rating?.current ?? null, rating?.previous ?? null),
          absence: absenceSignal(link?.consecutiveAbsences ?? 0),
        };

        return {
          character: m.character,
          cells: closed,
          current,
          baseline: decay.baseline,
          decayFlagged: decay.flagged,
          knownWeeks: decay.knownWeeks,
          avgActivity,
          activeWeeks,
          observedWeeks: observedScores.length,
          avgMplusRuns,
          signals,
          risk: riskScore(signals),
          watchlisted: watchlisted(signals),
          daysSinceLogin,
          currentRating: rating?.current ?? null,
          previousSeasonRating: rating?.previous ?? null,
          previousSeasonSlug: rating?.previousSlug ?? null,
          consecutiveAbsences: link?.consecutiveAbsences ?? 0,
        };
      });

      // Decay-severity-first ordering: watchlisted by risk, then flagged,
      // then the rest alphabetically — the heatmap's row order contract.
      members.sort((a, b) => {
        if (a.watchlisted !== b.watchlisted) return a.watchlisted ? -1 : 1;
        if (a.watchlisted && b.watchlisted && a.risk !== b.risk)
          return b.risk - a.risk;
        if (a.decayFlagged !== b.decayFlagged) return a.decayFlagged ? -1 : 1;
        return a.character.name.localeCompare(b.character.name);
      });

      const rosterMedian = closedWeeks.map((_, i) =>
        medianOf(
          members
            .map((mm) => mm.cells[i]?.score)
            .filter((s): s is number => s != null),
        ),
      );
      const rosterMedianCurrent = medianOf(
        members
          .map((mm) => mm.current.score)
          .filter((s): s is number => s != null),
      );

      // Roster-wide average activity frequency (mean of members' own averages).
      const memberAvgs = members
        .map((mm) => mm.avgActivity)
        .filter((a): a is number => a != null);
      const rosterAvgActivity =
        memberAvgs.length > 0
          ? memberAvgs.reduce((a, b) => a + b, 0) / memberAvgs.length
          : null;

      return {
        currentWeekStart: currentWeek,
        closedWeeks,
        rosterMedian,
        rosterMedianCurrent,
        rosterAvgActivity,
        members,
      };
    }),
});
