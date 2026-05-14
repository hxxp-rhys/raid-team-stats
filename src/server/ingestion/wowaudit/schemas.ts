import { z } from "zod";

/**
 * Placeholder zod schemas for the WoW Audit API.
 *
 * NOTE — these are *deliberately permissive* until we have the real API docs.
 * Each schema uses `.passthrough()` and treats almost every field as optional
 * so the client can fetch and surface data without crashing on unfamiliar
 * shapes. Once the WoW Audit reference is shared, tighten the types and
 * remove the `passthrough` where it's not needed for forward compatibility.
 *
 * The intent here is to make a single update path — change the schemas
 * below + the path constants in `client.ts` — to fully activate the
 * integration without touching the ingestion pipeline or the UI.
 */

// Team / guild metadata. Likely fields based on the public WoW Audit UI:
// team name, realm, region, current period (week/raid).
export const wowauditTeamSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    realm: z.string().optional(),
    region: z.string().optional(),
    faction: z.string().optional(),
  })
  .passthrough();
export type WowauditTeam = z.infer<typeof wowauditTeamSchema>;

// Single character record — superset of the typical audit-spreadsheet columns.
// Real schema will narrow these once we know the field names.
export const wowauditCharacterSchema = z
  .object({
    name: z.string(),
    realm: z.string().optional(),
    class: z.string().optional(),
    spec: z.string().optional(),
    role: z.string().optional(),
    rank: z.union([z.string(), z.number()]).optional(),

    // Gear / iLvL
    item_level: z.number().optional(),
    enchants_missing: z.number().optional(),
    gems_missing: z.number().optional(),
    tier_pieces: z.number().optional(),

    // Mythic+
    mplus_score: z.number().optional(),
    mplus_weekly_highest: z.number().optional(),

    // Vault
    vault_options: z.number().optional(),
    vault_slots: z.array(z.unknown()).optional(),

    // Raid
    raid_attendance: z.number().optional(),
    raid_progress: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type WowauditCharacter = z.infer<typeof wowauditCharacterSchema>;

// Roster response. The exact wrapper shape (array vs `{ characters: [...] }`)
// will be resolved once we have docs.
export const wowauditRosterResponseSchema = z.union([
  z.array(wowauditCharacterSchema),
  z
    .object({
      characters: z.array(wowauditCharacterSchema).default([]),
    })
    .passthrough(),
]);
export type WowauditRosterResponse = z.infer<typeof wowauditRosterResponseSchema>;
