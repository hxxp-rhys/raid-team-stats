import { env } from "@/env";

/**
 * Resolved Discord credentials, or null when the integration is not configured.
 * All three env vars must be present for Discord to turn on; any absent → the
 * bot is disabled and the rest of the app runs normally.
 */
export type DiscordConfig = {
  appId: string;
  publicKey: string;
  botToken: string;
};

export function discordConfig(): DiscordConfig | null {
  const appId = env.DISCORD_APP_ID;
  const publicKey = env.DISCORD_PUBLIC_KEY;
  const botToken = env.DISCORD_BOT_TOKEN;
  if (!appId || !publicKey || !botToken) return null;
  return { appId, publicKey, botToken };
}

export function isDiscordEnabled(): boolean {
  return discordConfig() !== null;
}

export const DISCORD_API_BASE = "https://discord.com/api/v10";
