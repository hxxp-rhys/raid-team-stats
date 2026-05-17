import { z } from "zod";

import {
  router,
  protectedProcedure,
  assertRaidTeamRole,
} from "@/server/api/trpc";
import { warcraftLogsClient } from "@/server/ingestion/warcraftlogs/client";
import { computeGearAudit } from "@/server/ingestion/gear-audit";

/**
 * Read-only access to the per-domain snapshot rows. Authorization rides on
 * raid-team membership — anyone who can see the team can read the snapshots
 * of its active members.
 */

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
