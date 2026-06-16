import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { blizzardClient } from "@/server/ingestion/blizzard/client";
import { endpoints } from "@/server/ingestion/blizzard/endpoints";
import { professionSkillTierResponseSchema } from "@/server/ingestion/blizzard/schemas";
import { normalizeName, type RecipeCategory } from "@/lib/widgets/professions-logic";

/**
 * The in-game recipe CATEGORIES (display order) for one profession skill tier,
 * from Blizzard game-data. STATIC per patch + identical for everyone, so cache
 * the category structure in Redis (not per-character results). A 7-day TTL
 * bounds post-patch staleness; the caller's "Other" orphan bucket absorbs any
 * new-recipe lag in the meantime. On any fetch failure → [] (caller falls back
 * to an alphabetical list).
 */

const TTL_SECONDS = 7 * 24 * 60 * 60;
const key = (region: string, profId: number, tierId: number) =>
  `prof-cat:${region.toLowerCase()}:${profId}:${tierId}`;

export async function getProfessionCategories(
  region: string,
  profId: number,
  tierId: number,
): Promise<RecipeCategory[]> {
  const k = key(region, profId, tierId);
  try {
    const cached = await redis.get(k);
    if (cached) return JSON.parse(cached) as RecipeCategory[];
  } catch (err) {
    logger.warn({ err, k }, "recipe-categories: redis get failed (continuing)");
  }

  try {
    const res = await blizzardClient().request(
      endpoints.professionSkillTier(region, profId, tierId),
      {
        region,
        schema: professionSkillTierResponseSchema,
        auth: { kind: "app" },
        minFloor: 0,
      },
    );
    const categories: RecipeCategory[] = (res.categories ?? []).map((c) => ({
      name: normalizeName(c.name),
      recipeIds: (c.recipes ?? [])
        .map((r) => (typeof r.id === "number" ? r.id : 0))
        .filter((id) => id > 0),
    }));
    try {
      await redis.set(k, JSON.stringify(categories), "EX", TTL_SECONDS);
    } catch (err) {
      logger.warn({ err, k }, "recipe-categories: redis set failed (continuing)");
    }
    return categories;
  } catch (err) {
    logger.warn({ err, region, profId, tierId }, "recipe-categories: game-data fetch failed");
    return [];
  }
}
