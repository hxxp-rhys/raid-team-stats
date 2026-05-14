import { db } from "@/lib/db";
import { encryptToken, decryptToken, isEncrypted } from "@/server/crypto/token-cipher";
import { logger } from "@/lib/logger";

/**
 * Per-guild WoW Audit configuration. The API key is stored AES-256-GCM-
 * encrypted in `Guild.wowauditApiKey` using the same token cipher that
 * protects OAuth refresh tokens.
 *
 * Read paths return only metadata + last-4-character preview. The plaintext
 * key is exposed exclusively via `loadDecryptedConfig()`, which is only
 * called from worker code inside the BullMQ process.
 */

export const DEFAULT_WOWAUDIT_BASE_URL = "https://wowaudit.com/v1";

export type WowauditPublicStatus = {
  configured: boolean;
  teamId: string | null;
  baseUrl: string | null;
  /** Last 4 chars of the (decrypted) key for visual confirmation. Never the full key. */
  keyHint: string | null;
};

export type WowauditDecryptedConfig = {
  apiKey: string;
  teamId: string | null;
  baseUrl: string;
};

export async function getPublicStatus(guildId: string): Promise<WowauditPublicStatus> {
  const guild = await db.guild.findUnique({
    where: { id: guildId },
    select: { wowauditApiKey: true, wowauditTeamId: true, wowauditBaseUrl: true },
  });
  if (!guild?.wowauditApiKey) {
    return { configured: false, teamId: null, baseUrl: null, keyHint: null };
  }

  let keyHint: string | null = null;
  try {
    const plaintext = decryptToken(guild.wowauditApiKey);
    keyHint = plaintext ? `…${plaintext.slice(-4)}` : null;
  } catch {
    // Decrypt failure (key rotated, tampering, etc) — surface as unconfigured.
    keyHint = null;
  }

  return {
    configured: keyHint !== null,
    teamId: guild.wowauditTeamId,
    baseUrl: guild.wowauditBaseUrl ?? DEFAULT_WOWAUDIT_BASE_URL,
    keyHint,
  };
}

/**
 * Worker-side: loads and decrypts the API key for actually calling WoW Audit.
 * Returns null if the guild has no configured key (worker should skip this
 * source rather than throwing).
 */
export async function loadDecryptedConfig(
  guildId: string,
): Promise<WowauditDecryptedConfig | null> {
  const guild = await db.guild.findUnique({
    where: { id: guildId },
    select: { wowauditApiKey: true, wowauditTeamId: true, wowauditBaseUrl: true },
  });
  if (!guild?.wowauditApiKey) return null;

  try {
    const apiKey = decryptToken(guild.wowauditApiKey);
    if (!apiKey) return null;
    return {
      apiKey,
      teamId: guild.wowauditTeamId,
      baseUrl: guild.wowauditBaseUrl ?? DEFAULT_WOWAUDIT_BASE_URL,
    };
  } catch (err) {
    logger.error({ err, guildId }, "wowaudit config decrypt failed");
    return null;
  }
}

/**
 * Setter — encrypts the API key with the token cipher and persists. Idempotent
 * for already-encrypted input (defensive — should never happen from the UI).
 * Caller is responsible for authorization checks.
 */
export async function setConfig(
  guildId: string,
  input: { apiKey: string; teamId?: string | null; baseUrl?: string | null },
): Promise<void> {
  if (!input.apiKey || input.apiKey.trim().length < 8) {
    throw new Error("wowaudit setConfig: apiKey must be at least 8 characters");
  }
  const ciphertext = isEncrypted(input.apiKey)
    ? input.apiKey
    : encryptToken(input.apiKey.trim());
  await db.guild.update({
    where: { id: guildId },
    data: {
      wowauditApiKey: ciphertext,
      wowauditTeamId: input.teamId ?? null,
      wowauditBaseUrl: input.baseUrl?.trim() || null,
    },
  });
}

export async function clearConfig(guildId: string): Promise<void> {
  await db.guild.update({
    where: { id: guildId },
    data: {
      wowauditApiKey: null,
      wowauditTeamId: null,
      wowauditBaseUrl: null,
    },
  });
}
