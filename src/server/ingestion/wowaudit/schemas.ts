import { z } from "zod";

/**
 * WoW Audit v1 API schemas.
 *
 * Grounded in the WoW Audit data model (github.com/wowaudit/core):
 *   - The Great Vault is exposed as nine flat columns
 *     `great_vault_slot_1` … `great_vault_slot_9`. WoW's vault has three
 *     rows of three — Raid (1-3), Mythic+ (4-6), World/Delves (7-9). Each
 *     value is the reward item level (0 / null / "" = slot not unlocked).
 *   - `delve_info` carries per-tier Delve completion counts and a `total`
 *     — a secondary source for the World row when the slot columns are
 *     absent (older addon versions).
 *
 * Everything stays `.optional()` + `.passthrough()`: the API returns a wide
 * row and we only need identity + the vault. The integration activates as
 * soon as a guild's WoW Audit key is configured — no further code change.
 */

const slotValue = z.union([z.number(), z.string(), z.null()]).optional();

export const wowauditDelveInfoSchema = z
  .object({
    total: z.number().optional(),
  })
  .passthrough();

export const wowauditCharacterSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string(),
    realm: z.string().optional(),
    class: z.string().optional(),
    role: z.string().optional(),

    great_vault_slot_1: slotValue,
    great_vault_slot_2: slotValue,
    great_vault_slot_3: slotValue,
    great_vault_slot_4: slotValue,
    great_vault_slot_5: slotValue,
    great_vault_slot_6: slotValue,
    great_vault_slot_7: slotValue,
    great_vault_slot_8: slotValue,
    great_vault_slot_9: slotValue,

    delve_info: wowauditDelveInfoSchema.optional(),
  })
  .passthrough();
export type WowauditCharacter = z.infer<typeof wowauditCharacterSchema>;

// Team / guild metadata (kept permissive — only used by the "test
// connection" probe and status display).
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

// The /characters endpoint returns either a bare array or a wrapped object.
export const wowauditRosterResponseSchema = z.union([
  z.array(wowauditCharacterSchema),
  z
    .object({
      characters: z.array(wowauditCharacterSchema).default([]),
    })
    .passthrough(),
]);
export type WowauditRosterResponse = z.infer<typeof wowauditRosterResponseSchema>;
