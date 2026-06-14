import { DISCORD_API_BASE, discordConfig } from "./config";

/**
 * Outbound Discord REST (bot token). Thin wrapper that returns a discriminated
 * result rather than throwing, surfaces 429 `Retry-After` (the only
 * authoritative limit), and no-ops cleanly when Discord isn't configured. All
 * callers (fan-out worker, interaction handler, command registrar) go through
 * here so the auth header + base URL live in one place.
 */

export type DiscordRest<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; retryAfterMs?: number; error: string };

async function discordFetch<T>(
  path: string,
  init: RequestInit,
): Promise<DiscordRest<T>> {
  const cfg = discordConfig();
  if (!cfg) return { ok: false, status: 0, error: "discord not configured" };

  let res: Response;
  try {
    res = await fetch(`${DISCORD_API_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bot ${cfg.botToken}`,
        "content-type": "application/json",
        "user-agent": "StatSmith (https://github.com/, 1.0)",
        ...init.headers,
      },
    });
  } catch (err) {
    return { ok: false, status: 0, error: `fetch failed: ${String(err)}` };
  }

  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after") ?? "1");
    return {
      ok: false,
      status: 429,
      retryAfterMs: Math.max(1000, Math.ceil((Number.isFinite(ra) ? ra : 1) * 1000)),
      error: "rate limited",
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: body.slice(0, 300) || res.statusText };
  }
  const data =
    res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  return { ok: true, status: res.status, data };
}

export type DiscordMessage = {
  id: string;
  author?: { id: string };
  embeds?: { footer?: { text?: string } }[];
};

export function postMessage(
  channelId: string,
  payload: unknown,
): Promise<DiscordRest<DiscordMessage>> {
  return discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function patchMessage(
  channelId: string,
  messageId: string,
  payload: unknown,
): Promise<DiscordRest<DiscordMessage>> {
  return discordFetch(`/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

/** Recent bot messages in a channel — used for create-or-adopt 404 recovery. */
export function getChannelMessages(
  channelId: string,
  limit = 50,
): Promise<DiscordRest<DiscordMessage[]>> {
  return discordFetch(`/channels/${channelId}/messages?limit=${limit}`, {
    method: "GET",
  });
}

/** Open (or fetch) a DM channel with a user — for DM-mode reminders. */
export function createDmChannel(
  userId: string,
): Promise<DiscordRest<{ id: string }>> {
  return discordFetch(`/users/@me/channels`, {
    method: "POST",
    body: JSON.stringify({ recipient_id: userId }),
  });
}

/** Bulk-overwrite a guild's slash commands (used by the registrar). */
export function putGuildCommands(
  guildId: string,
  commands: unknown[],
): Promise<DiscordRest<unknown>> {
  const cfg = discordConfig();
  if (!cfg) return Promise.resolve({ ok: false, status: 0, error: "discord not configured" });
  return discordFetch(`/applications/${cfg.appId}/guilds/${guildId}/commands`, {
    method: "PUT",
    body: JSON.stringify(commands),
  });
}
