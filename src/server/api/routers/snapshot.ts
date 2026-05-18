import { z } from "zod";

import {
  router,
  protectedProcedure,
  assertRaidTeamRole,
} from "@/server/api/trpc";
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
  lockouts: Array<{
    name: string;
    difficulty: string | null;
    killed: number;
    total: number;
    extended: boolean;
  }>;
  currencies: Array<{
    name: string;
    quantity: number | null;
    max: number | null;
  }>;
  consumables: {
    flask: number;
    potion: number;
    food: number;
    weaponEnh: number;
    other: number;
  };
  delves: {
    season: number | null;
    tier: number | null;
    brann: number | null;
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

  const lockouts = (p.lockouts ?? [])
    .filter((l) => l.isRaid === true)
    .map((l) => {
      const bosses = l.bosses ?? [];
      return {
        name: l.name ?? "?",
        difficulty: l.difficulty ?? null,
        killed: bosses.filter((b) => b.killed === true).length,
        total: bosses.length || (l.encounters ?? 0),
        extended: l.extended === true,
      };
    });

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
      max: c.maxQuantity ?? null,
    }))
    .slice(0, 12);

  const consumables = { flask: 0, potion: 0, food: 0, weaponEnh: 0, other: 0 };
  for (const it of p.consumables?.items ?? []) {
    const n = it.count ?? 0;
    if (it.sub === 3) consumables.flask += n;
    else if (it.sub === 1) consumables.potion += n;
    else if (it.sub === 5) consumables.food += n;
    else if (it.sub === 6) consumables.weaponEnh += n;
    else consumables.other += n;
  }

  const dapi = (p.delves?.api ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" ? v : null;
  const delvesObj = p.delves
    ? {
        season:
          num(dapi.GetCurrentDelvesSeasonNumber) ??
          num(dapi.GetDelvesSeasonNumber),
        tier: num(dapi.GetCurrentDelveTier),
        brann: num(p.delves.companion?.level),
      }
    : null;
  const delves =
    delvesObj &&
    (delvesObj.season != null ||
      delvesObj.tier != null ||
      delvesObj.brann != null)
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
});
