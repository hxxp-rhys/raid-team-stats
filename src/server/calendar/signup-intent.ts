import type { ExtendedPrismaClient } from "@/lib/db";
import { endInstant } from "@/lib/calendar/time";
import { audit } from "@/server/security/audit";
import { appendOutbox } from "@/server/calendar/sync";

/**
 * THE single place a signup intent is applied to the DB — shared by the website
 * (tRPC `setStatus`), Discord (interaction handler), and later the addon. Keeps
 * the "intents not state" contract identical across surfaces: idempotent claim,
 * per-(event,character) upsert, version bump, and an outbox row in ONE tx, plus
 * the guards (past/cancelled/not-a-member). The CALLER authorizes the actor and
 * resolves the character; this enforces the event-level + membership invariants
 * every surface must share.
 */

export type SignupState = "CONFIRM" | "TENTATIVE" | "LATE" | "ABSENT";

export type ApplySignupArgs = {
  /** Owner of the signup (whose attendance it is). */
  userId: string;
  eventId: string;
  characterId: string;
  state: SignupState;
  etaMinutes?: number | null;
  reason?: string | null;
  comment?: string | null;
  source: "WEBSITE" | "DISCORD" | "ADDON" | "LEADER";
  /** sha256 idempotency key — replays are no-ops. */
  idempotencyKey: string;
  /** The actor performing the change (== userId for self, leader on-behalf, etc.). */
  updatedByUserId: string;
};

export type ApplySignupResult =
  | { ok: true; applied: boolean; characterId: string; raidTeamId: string }
  | { ok: false; reason: "not_found" | "past" | "cancelled" | "not_member" };

export async function applySignupIntent(
  db: ExtendedPrismaClient,
  args: ApplySignupArgs,
): Promise<ApplySignupResult> {
  const event = await db.raidEvent.findUnique({
    where: { id: args.eventId },
    select: { raidTeamId: true, startsAt: true, durationMin: true, status: true },
  });
  if (!event) return { ok: false, reason: "not_found" };
  if (endInstant(event.startsAt, event.durationMin).getTime() < Date.now()) {
    return { ok: false, reason: "past" };
  }
  if (event.status === "CANCELLED") return { ok: false, reason: "cancelled" };

  // Membership gate (B4): the character must be active on THIS team. Authority
  // independent of the caller, so an off-team character can never pollute a
  // roster regardless of which surface sent the intent.
  const member = await db.raidTeamMembership.findFirst({
    where: { raidTeamId: event.raidTeamId, characterId: args.characterId, isActive: true },
    select: { id: true },
  });
  if (!member) return { ok: false, reason: "not_member" };

  const eta = args.state === "LATE" ? (args.etaMinutes ?? null) : null;

  const result = await db.$transaction(async (tx) => {
    // Idempotency: first writer wins; a replay inserts 0 rows and is a no-op.
    const claimed = await tx.processedIntent.createMany({
      data: { idempotencyKey: args.idempotencyKey, raidEventId: args.eventId, userId: args.userId },
      skipDuplicates: true,
    });
    if (claimed.count === 0) return { applied: false as const };

    const signup = await tx.eventSignup.upsert({
      where: { raidEventId_characterId: { raidEventId: args.eventId, characterId: args.characterId } },
      create: {
        raidEventId: args.eventId,
        userId: args.userId,
        characterId: args.characterId,
        state: args.state,
        etaMinutes: eta,
        reason: args.reason ?? null,
        comment: args.comment ?? null,
        source: args.source,
        updatedByUserId: args.updatedByUserId,
      },
      update: {
        state: args.state,
        etaMinutes: eta,
        reason: args.reason ?? null,
        comment: args.comment ?? null,
        source: args.source,
        updatedByUserId: args.updatedByUserId,
        version: { increment: 1 },
      },
      select: { version: true },
    });
    await appendOutbox(tx, {
      raidTeamId: event.raidTeamId,
      raidEventId: args.eventId,
      kind: "signup.changed",
      payload: { eventId: args.eventId, characterId: args.characterId, state: args.state },
      version: signup.version,
      idempotencyKey: args.idempotencyKey,
    });
    return { applied: true as const };
  });

  await audit({
    event: "CALENDAR_SIGNUP_CHANGED",
    actorUserId: args.updatedByUserId,
    subjectType: "raidEvent",
    subjectId: args.eventId,
    metadata: { state: args.state, characterId: args.characterId, source: args.source },
  });

  return { ok: true, applied: result.applied, characterId: args.characterId, raidTeamId: event.raidTeamId };
}
