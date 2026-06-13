/**
 * Auto-reminder sweep. For every upcoming event in the lookahead window, decide
 * which reminder kinds are due (pure `dueReminders`), resolve the recipients
 * for that audience, and — for each recipient with a reachable verified email —
 * CLAIM a SentReminder row before sending. The unique (event, kind, user)
 * constraint is the exactly-once authority: it holds across worker restarts and
 * multiple replicas without any lock, and a send failure leaves the claim in
 * place (email is best-effort by design; we never double-send to retry).
 */

import { env } from "@/env";
import type { ExtendedPrismaClient } from "@/lib/db";
import { logger } from "@/lib/logger";
import { sendRaidReminderEmail } from "@/lib/email";
import {
  dueReminders,
  parseReminderConfig,
  REMINDER_LOOKAHEAD_MINUTES,
} from "@/lib/calendar/reminder-policy";

// How far ahead to pull candidate events. Derived from the schema's max
// configurable lead + grace (REMINDER_LOOKAHEAD_MINUTES), so it always covers
// the firing window of any storable config — the two can't drift apart.
const LOOKAHEAD_MINUTES = REMINDER_LOOKAHEAD_MINUTES;

const GOING_STATES = new Set(["CONFIRM", "TENTATIVE", "LATE"]);

/** Active team members, by user id (a person, not a character). */
async function teamMemberUserIds(
  db: ExtendedPrismaClient,
  raidTeamId: string,
): Promise<Set<string>> {
  const ms = await db.raidTeamMembership.findMany({
    where: { raidTeamId, isActive: true },
    select: { character: { select: { userId: true } } },
  });
  return new Set(ms.map((m) => m.character.userId));
}

export async function runReminderSweep(
  db: ExtendedPrismaClient,
  opts?: { now?: Date },
): Promise<{ events: number; sent: number }> {
  const now = opts?.now ?? new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_MINUTES * 60_000);

  const events = await db.raidEvent.findMany({
    where: {
      startsAt: { gt: now, lte: horizon },
      status: { in: ["PLANNED", "LOCKED"] },
    },
    select: {
      id: true,
      raidTeamId: true,
      title: true,
      startsAt: true,
      timezone: true,
      raidTeam: {
        select: { id: true, guildId: true, name: true, reminderConfig: true },
      },
      signups: { select: { userId: true, state: true } },
    },
  });

  let sent = 0;
  for (const e of events) {
    const cfg = parseReminderConfig(e.raidTeam.reminderConfig);
    const due = dueReminders(cfg, e.startsAt.getTime(), now.getTime());
    if (due.length === 0) continue;

    for (const d of due) {
      // Resolve the audience to a set of user ids.
      let recipientIds: Set<string>;
      if (d.audience === "going") {
        recipientIds = new Set(
          e.signups.filter((s) => GOING_STATES.has(s.state)).map((s) => s.userId),
        );
      } else {
        const members = await teamMemberUserIds(db, e.raidTeamId);
        const responded = new Set(e.signups.map((s) => s.userId));
        recipientIds = new Set([...members].filter((u) => !responded.has(u)));
      }
      if (recipientIds.size === 0) continue;

      // Only users we can actually reach (verified email).
      const users = await db.user.findMany({
        where: {
          id: { in: [...recipientIds] },
          email: { not: null },
          emailVerified: { not: null },
        },
        select: { id: true, email: true },
      });

      for (const u of users) {
        if (!u.email) continue;
        // Claim exactly-once BEFORE sending.
        const claim = await db.sentReminder.createMany({
          data: [{ raidEventId: e.id, kind: d.kind, userId: u.id }],
          skipDuplicates: true,
        });
        if (claim.count === 0) continue; // already sent this kind to this user

        try {
          await sendRaidReminderEmail({
            to: u.email,
            teamName: e.raidTeam.name,
            title: e.title,
            startsAt: e.startsAt,
            timezone: e.timezone,
            audience: d.audience,
            eventUrl: `${env.APP_URL}/guild/${e.raidTeam.guildId}/team/${e.raidTeam.id}/calendar?event=${e.id}`,
          });
          sent++;
        } catch (err) {
          // Claim stays — email is best-effort; we don't retry to avoid dupes.
          logger.warn(
            { err, eventId: e.id, userId: u.id, kind: d.kind },
            "reminder: send failed (claim kept)",
          );
        }
      }
    }
  }
  return { events: events.length, sent };
}
