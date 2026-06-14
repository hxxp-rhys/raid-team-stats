import type { ExtendedPrismaClient } from "@/lib/db";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { isDiscordEnabled } from "@/lib/discord/config";
import { renderEventToDiscord } from "./render";

/**
 * Auto-post sweep (time-driven, opt-in). The outbox relay is CHANGE-driven, so
 * an event scheduled far out never re-triggers when it later enters its lead
 * window. This sweep covers that: for each team with auto-post ON, post the
 * boards for raids that have entered the window but aren't posted yet. Off by
 * default — a team posts manually until they opt in.
 */
export async function runDiscordAutoPost(
  db: ExtendedPrismaClient,
): Promise<{ skipped?: boolean; posted?: number }> {
  if (!isDiscordEnabled()) return { skipped: true };
  const integrations = await db.discordIntegration.findMany({
    where: { autoPostEnabled: true },
    select: { raidTeamId: true, autoPostLeadDays: true },
  });
  const now = new Date();
  let posted = 0;
  for (const ig of integrations) {
    const horizon = new Date(now.getTime() + ig.autoPostLeadDays * 86_400_000);
    const due = await db.raidEvent.findMany({
      where: {
        raidTeamId: ig.raidTeamId,
        discordMessageId: null,
        status: { not: "CANCELLED" },
        startsAt: { gt: now, lte: horizon },
      },
      orderBy: { startsAt: "asc" },
      select: { id: true },
    });
    for (const e of due) {
      const out = await renderEventToDiscord(db, e.id);
      if (out.ok) {
        if (out.action === "posted" || out.action === "adopted") posted++;
      } else if (out.retryAfterMs) {
        break; // rate limited — pick up the rest next sweep
      }
    }
  }
  if (posted > 0) logger.info({ posted }, "discord auto-post sweep");
  return { posted };
}

/**
 * Discord fan-out relay. Drains each Discord-bound team's SyncOutbox past its
 * per-consumer DeliveryCursor, COALESCES the touched events (N signups in one
 * sweep → one render per event), re-renders each from current DB state, and
 * advances the cursor. The sweep interval IS the coalesce debounce; processing
 * a team's events sequentially keeps that team's single channel bucket serial
 * (M2). A render that 429s halts the team's cursor so the whole batch retries
 * after Retry-After; a non-rate-limit render failure is logged and skipped
 * (state-convergent — the next signup change re-renders it), so no poison row
 * blocks the stream.
 */

const CONSUMER = "discord";
const BATCH = 200;
const SWEEP_LOCK_KEY = "discord:fanout:lock";
const SWEEP_LOCK_TTL_MS = 8_000;

export async function runDiscordFanout(
  db: ExtendedPrismaClient,
): Promise<{ skipped?: boolean; teams?: number; rendered?: number }> {
  if (!isDiscordEnabled()) return { skipped: true };

  // Soft lock so two overlapping sweeps don't double-render. The DeliveryCursor
  // is still the authority; this just avoids redundant work.
  let locked = false;
  try {
    locked = (await redis.set(SWEEP_LOCK_KEY, "1", "PX", SWEEP_LOCK_TTL_MS, "NX")) !== null;
  } catch {
    locked = true; // redis down → fail open
  }
  if (!locked) return { skipped: true };

  try {
    const integrations = await db.discordIntegration.findMany({
      select: { raidTeamId: true },
    });
    let rendered = 0;
    for (const { raidTeamId } of integrations) {
      try {
        rendered += await fanoutTeam(db, raidTeamId);
      } catch (err) {
        logger.warn({ err, raidTeamId }, "discord fanout: team failed");
      }
    }
    if (rendered > 0) logger.info({ teams: integrations.length, rendered }, "discord fanout");
    return { teams: integrations.length, rendered };
  } finally {
    await redis.del(SWEEP_LOCK_KEY).catch(() => undefined);
  }
}

async function fanoutTeam(
  db: ExtendedPrismaClient,
  raidTeamId: string,
): Promise<number> {
  const cursor = await db.deliveryCursor.findUnique({
    where: { consumer_raidTeamId: { consumer: CONSUMER, raidTeamId } },
    select: { lastOutboxId: true },
  });
  const since = cursor?.lastOutboxId ?? BigInt(0);

  const rows = await db.syncOutbox.findMany({
    where: { raidTeamId, id: { gt: since } },
    orderBy: { id: "asc" },
    take: BATCH,
    select: { id: true, raidEventId: true },
  });
  if (rows.length === 0) return 0;

  // Coalesce: one render per distinct event in this batch, in first-seen order.
  const eventIds: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.raidEventId && !seen.has(r.raidEventId)) {
      seen.add(r.raidEventId);
      eventIds.push(r.raidEventId);
    }
  }

  let rendered = 0;
  for (const eventId of eventIds) {
    const out = await renderEventToDiscord(db, eventId);
    if (out.ok) {
      rendered++;
    } else if (out.retryAfterMs) {
      // Rate limited — do NOT advance the cursor; the whole batch retries next
      // sweep (already-rendered events just re-PATCH, which is idempotent).
      logger.info({ raidTeamId, retryAfterMs: out.retryAfterMs }, "discord fanout: rate limited, retrying");
      return rendered;
    } else {
      logger.warn({ eventId, reason: out.reason }, "discord fanout: render failed (skipping)");
    }
  }

  const maxId = rows[rows.length - 1]!.id;
  await db.deliveryCursor.upsert({
    where: { consumer_raidTeamId: { consumer: CONSUMER, raidTeamId } },
    create: { consumer: CONSUMER, raidTeamId, lastOutboxId: maxId },
    update: { lastOutboxId: maxId },
  });
  return rendered;
}
