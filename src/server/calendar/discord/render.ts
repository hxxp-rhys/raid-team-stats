import { env } from "@/env";
import type { ExtendedPrismaClient } from "@/lib/db";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { inferRole } from "@/lib/wow";
import {
  buildRoster,
  parseComp,
  type RosterMember,
  type AttendanceState as RosterState,
} from "@/lib/calendar/roster";
import {
  buildEventMessage,
  eventIdFromFooter,
  type EmbedEvent,
} from "@/lib/discord/embed";
import {
  deleteMessage,
  getChannelMessages,
  patchMessage,
  postMessage,
} from "@/lib/discord/rest";

/**
 * Best-effort removal of an event's posted board — call BEFORE hard-deleting an
 * event (the relay can't clean up a row that no longer exists). No-ops cleanly
 * when the event was never posted or Discord is off.
 */
export async function removeEventBoard(
  channelId: string | null | undefined,
  messageId: string | null | undefined,
): Promise<void> {
  if (!channelId || !messageId) return;
  await deleteMessage(channelId, messageId).catch(() => undefined);
}

/**
 * Render ONE event's signup board into its team's Discord channel — POST the
 * first time, PATCH in place after. The website DB is the source of truth; this
 * always re-renders from current state (state-convergent, so a dropped edit
 * heals on the next render). Self-heals a deleted message via create-or-adopt
 * behind a dedicated re-post lock so two jobs can't post twin embeds (M3).
 */

const REPOST_LOCK_TTL_MS = 15_000;

type LoadedEvent = {
  event: EmbedEvent;
  raidTeamId: string;
  guildId: string;
  durationMin: number;
  discordChannelId: string | null;
  discordMessageId: string | null;
  integrationChannelId: string | null;
};

/** Load an event + its role-grouped roster (mirrors the eventDetail builder). */
async function loadEventRoster(
  db: ExtendedPrismaClient,
  eventId: string,
): Promise<{ loaded: LoadedEvent; roster: ReturnType<typeof buildRoster> } | null> {
  const event = await db.raidEvent.findUnique({
    where: { id: eventId },
    include: {
      signups: true,
      raidTeam: {
        select: {
          guildId: true,
          compTemplate: true,
          discordIntegration: { select: { channelId: true } },
        },
      },
    },
  });
  if (!event) return null;

  const memberships = await db.raidTeamMembership.findMany({
    where: { raidTeamId: event.raidTeamId, isActive: true },
    select: { character: { select: { id: true, name: true, classId: true, userId: true } } },
  });
  const charIds = memberships.map((m) => m.character.id);
  const specRows = charIds.length
    ? await db.characterSnapshot.findMany({
        where: { characterId: { in: charIds }, source: "BLIZZARD" },
        orderBy: { capturedAt: "desc" },
        distinct: ["characterId"],
        select: { characterId: true, specName: true },
      })
    : [];
  const specByChar = new Map(specRows.map((s) => [s.characterId, s.specName]));
  const signupByChar = new Map(event.signups.map((s) => [s.characterId, s]));

  const members: RosterMember[] = memberships.map((m) => {
    const c = m.character;
    const s = signupByChar.get(c.id);
    return {
      userId: c.userId,
      characterId: c.id,
      name: c.name,
      classId: c.classId,
      role: inferRole(c.classId, specByChar.get(c.id) ?? null),
      state: (s?.state ?? "NO_RESPONSE") as RosterState,
      etaMinutes: s?.etaMinutes ?? null,
      reason: s?.reason ?? null,
      selection: s?.selection ?? null,
      source: s?.source ?? null,
      updatedAt: s?.updatedAt.toISOString() ?? null,
    };
  });
  const roster = buildRoster(members, parseComp(event.raidTeam.compTemplate));

  return {
    loaded: {
      event: {
        id: event.id,
        title: event.title,
        difficulty: event.difficulty,
        raidSize: event.raidSize,
        startsAt: event.startsAt,
        status: event.status,
        notes: event.notes,
      },
      raidTeamId: event.raidTeamId,
      guildId: event.raidTeam.guildId,
      durationMin: event.durationMin,
      discordChannelId: event.discordChannelId,
      discordMessageId: event.discordMessageId,
      integrationChannelId: event.raidTeam.discordIntegration?.channelId ?? null,
    },
    roster,
  };
}

function eventUrl(guildId: string, raidTeamId: string, eventId: string): string {
  return `${env.APP_URL}/guild/${guildId}/team/${raidTeamId}/calendar?event=${eventId}`;
}

export type RenderOutcome =
  | { ok: true; action: "patched" | "posted" | "adopted" | "skipped" }
  | { ok: false; retryAfterMs?: number; reason: string };

export async function renderEventToDiscord(
  db: ExtendedPrismaClient,
  eventId: string,
): Promise<RenderOutcome> {
  const data = await loadEventRoster(db, eventId);
  if (!data) return { ok: false, reason: "event not found" };
  const { loaded, roster } = data;

  // Prefer the team's CURRENT integration channel over any channel a past
  // render stamped on the event — so re-binding a team to a new channel
  // migrates the board there instead of editing the abandoned channel forever.
  const channelId = loaded.integrationChannelId ?? loaded.discordChannelId;
  if (!channelId) return { ok: true, action: "skipped" }; // team not bound to a channel

  // Never post a board for a finished raid (guards against any backfill of past
  // events on a (re)bind; a live board is still editable to show cancellation).
  const finished =
    loaded.event.startsAt.getTime() + loaded.durationMin * 60_000 < Date.now();
  if (finished && !loaded.discordMessageId) return { ok: true, action: "skipped" };

  const message = buildEventMessage(loaded.event, roster, {
    eventUrl: eventUrl(loaded.guildId, loaded.raidTeamId, eventId),
  });

  // Edit in place ONLY when the existing message is in the channel we're now
  // targeting. If the channel changed (re-bind), fall through to post in the
  // new channel (the old message is left as-is — we never delete history).
  if (loaded.discordMessageId && loaded.discordChannelId === channelId) {
    const res = await patchMessage(channelId, loaded.discordMessageId, message);
    if (res.ok) return { ok: true, action: "patched" };
    if (res.status === 429) return { ok: false, retryAfterMs: res.retryAfterMs, reason: "rate limited" };
    if (res.status !== 404) {
      return { ok: false, reason: `patch ${res.status}: ${res.error}` };
    }
    // 404 → the message was deleted; fall through to create-or-adopt.
  }

  return createOrAdopt(db, eventId, channelId, message);
}

async function createOrAdopt(
  db: ExtendedPrismaClient,
  eventId: string,
  channelId: string,
  message: { embeds: unknown[]; components: unknown[] },
): Promise<RenderOutcome> {
  const lockKey = `discord:repost:lock:${eventId}`;
  let locked = false;
  try {
    const got = await redis.set(lockKey, "1", "PX", REPOST_LOCK_TTL_MS, "NX");
    locked = got !== null;
  } catch (err) {
    logger.warn({ err, eventId }, "discord repost lock unavailable; proceeding");
    locked = true; // fail-open; the adopt step prevents most duplicates anyway
  }
  if (!locked) {
    // Another job is (re)posting this event — skip; the next render reads its id.
    return { ok: true, action: "skipped" };
  }

  try {
    // Adopt an existing embed for this event (footer marker) before posting a
    // second one — survives a crash mid-repost / a racing relay.
    const recent = await getChannelMessages(channelId, 50);
    if (recent.ok) {
      const existing = recent.data.find(
        (m) => m.embeds?.some((e) => eventIdFromFooter(e.footer?.text) === eventId),
      );
      if (existing) {
        await db.raidEvent.update({
          where: { id: eventId },
          data: { discordChannelId: channelId, discordMessageId: existing.id },
        });
        // Bring the adopted message up to date — honor a 429 so the cursor
        // halts and retries (the linkage is already stored, so retry is a
        // straight idempotent PATCH).
        const p = await patchMessage(channelId, existing.id, message);
        if (!p.ok && p.status === 429) {
          return { ok: false, retryAfterMs: p.retryAfterMs, reason: "rate limited" };
        }
        return { ok: true, action: "adopted" };
      }
    }

    const posted = await postMessage(channelId, message);
    if (!posted.ok) {
      if (posted.status === 429) {
        return { ok: false, retryAfterMs: posted.retryAfterMs, reason: "rate limited" };
      }
      return { ok: false, reason: `post ${posted.status}: ${posted.error}` };
    }
    await db.raidEvent.update({
      where: { id: eventId },
      data: { discordChannelId: channelId, discordMessageId: posted.data.id },
    });
    return { ok: true, action: "posted" };
  } finally {
    await redis.del(lockKey).catch(() => undefined);
  }
}
