import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import {
  router,
  protectedProcedure,
  assertRaidTeamRole,
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
import { warcraftLogsClient } from "@/server/ingestion/warcraftlogs/client";
import { computeGearAudit } from "@/server/ingestion/gear-audit";
import {
  addonPayloadSchema,
  deriveVaultDetail,
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
  latestForTeam: protectedProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      // Any team member or guild OWNER/OFFICER may read.
      await assertRaidTeamRole(ctx, input.raidTeamId, "MEMBER");

      const memberships = await ctx.db.raidTeamMembership.findMany({
        where: { raidTeamId: input.raidTeamId, isActive: true },
        include: {
          character: {
            select: {
              id: true,
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
              take: 30,
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
                addonVersion: true,
                payload: true,
              },
            }),
          ]),
        ),
      );

      // The live raid tier's WCL zone id, resolved server-side (env-pinned
      // to the current Midnight raid → no network call). Widgets filter
      // parses to exactly this zone so stale past-expansion rows (e.g. The
      // War Within) can never leak into the current-tier views.
      const currentRaidZoneId =
        (await warcraftLogsClient().currentRaidZoneId()) ?? null;

      return {
        currentRaidZoneId,
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
          return {
            character: m.character,
            role: m.role,
            latest: {
              character: latest[i]![0],
              equipment,
              mplus: latest[i]![2],
              vault,
              raid: latest[i]![4],
              wclParses: latest[i]![5],
              addon: addonView,
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
  characterTimeline: protectedProcedure
    .input(
      z.object({
        characterId: z.string().cuid(),
        days: z.number().int().min(7).max(180).default(60),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Authorize via team membership: any team the character is on grants
      // access. assertRaidTeamRole on every team is overkill — we just check
      // there's *some* shared team the caller can read.
      const sharedMembership = await ctx.db.raidTeamMembership.findFirst({
        where: {
          characterId: input.characterId,
          isActive: true,
          raidTeam: {
            OR: [
              { memberships: { some: { character: { userId: ctx.session.user.id }, isActive: true } } },
              { guild: { memberships: { some: { userId: ctx.session.user.id, status: "ACTIVE", role: { in: ["OWNER", "OFFICER"] } } } } },
            ],
          },
        },
        select: { id: true },
      });
      if (!sharedMembership) {
        return { points: [] as Array<{ at: Date; itemLevel: number | null }> };
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
  engagementPulse: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        weeks: z.number().int().min(4).max(26).default(12),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { guildId } = await assertRaidTeamRole(
        ctx,
        input.raidTeamId,
        "MEMBER",
      );

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

      return {
        currentWeekStart: currentWeek,
        closedWeeks,
        rosterMedian,
        rosterMedianCurrent,
        members,
      };
    }),
});
