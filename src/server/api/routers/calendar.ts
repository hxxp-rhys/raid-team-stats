import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  router,
  protectedProcedure,
  assertRaidTeamRole,
} from "@/server/api/trpc";
import type { ExtendedPrismaClient } from "@/lib/db";
import { audit } from "@/server/security/audit";
import { inferRole } from "@/lib/wow";
import {
  buildRoster,
  parseComp,
  type AttendanceState as RosterState,
  type RosterMember,
} from "@/lib/calendar/roster";
import {
  endInstant,
  isValidTimeZone,
  zonedWallClockToUtc,
} from "@/lib/calendar/time";
import {
  appendOutbox,
  intentKey,
  serverActionKey,
} from "@/server/calendar/sync";

const stateSchema = z.enum(["CONFIRM", "TENTATIVE", "LATE", "ABSENT"]);
const difficultySchema = z.enum(["Mythic", "Heroic", "Normal", "LFR"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{1,2}:\d{2}$/;

/** Team home timezone, defaulting to UTC. */
async function teamTz(
  db: ExtendedPrismaClient,
  raidTeamId: string,
): Promise<{ timezone: string; compTemplate: unknown }> {
  const t = await db.raidTeam.findUnique({
    where: { id: raidTeamId },
    select: { timezone: true, compTemplate: true },
  });
  return {
    timezone: t?.timezone && isValidTimeZone(t.timezone) ? t.timezone : "UTC",
    compTemplate: t?.compTemplate ?? null,
  };
}

/** Resolve the caller's default character for a team (their first active membership char). */
async function defaultCharacterId(
  db: ExtendedPrismaClient,
  userId: string,
  raidTeamId: string,
  preferred?: string,
): Promise<string> {
  const memberships = await db.raidTeamMembership.findMany({
    where: {
      raidTeamId,
      isActive: true,
      character: { userId },
    },
    select: { characterId: true },
    orderBy: { id: "asc" },
  });
  if (memberships.length === 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You have no active character on this raid team.",
    });
  }
  if (preferred && memberships.some((m) => m.characterId === preferred)) {
    return preferred;
  }
  return memberships[0]!.characterId;
}

/** Compact client-facing event row (no full roster — that's eventDetail). */
function eventSummary(e: {
  id: string;
  title: string;
  difficulty: string;
  raidSize: number | null;
  startsAt: Date;
  durationMin: number;
  timezone: string;
  localTime: string;
  occurrenceDate: string;
  status: string;
  seriesId: string | null;
  notes: string | null;
  version: number;
}) {
  return {
    id: e.id,
    title: e.title,
    difficulty: e.difficulty,
    raidSize: e.raidSize,
    startsAt: e.startsAt,
    endsAt: endInstant(e.startsAt, e.durationMin),
    durationMin: e.durationMin,
    timezone: e.timezone,
    localTime: e.localTime,
    occurrenceDate: e.occurrenceDate,
    status: e.status,
    seriesId: e.seriesId,
    notes: e.notes,
    version: e.version,
  };
}

export const calendarRouter = router({
  /** Team calendar settings + the caller's role (for gating the UI). */
  meta: protectedProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "MEMBER");
      const { timezone, compTemplate } = await teamTz(ctx.db, input.raidTeamId);
      // Resolve the caller's max role on the team (for showing leader controls).
      let role: "MEMBER" | "CO_LEADER" | "LEADER" = "MEMBER";
      try {
        await assertRaidTeamRole(ctx, input.raidTeamId, "LEADER");
        role = "LEADER";
      } catch {
        try {
          await assertRaidTeamRole(ctx, input.raidTeamId, "CO_LEADER");
          role = "CO_LEADER";
        } catch {
          role = "MEMBER";
        }
      }
      return { timezone, comp: parseComp(compTemplate), role };
    }),

  /** Events overlapping [from, to] with the viewer's own state + readiness counts. */
  eventsInRange: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        from: z.date(),
        to: z.date(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "MEMBER");
      if (input.to <= input.from) return { events: [] };
      // The viewer's default character (same resolution as setStatus writes),
      // so the shown "my status" always matches the char a click would update.
      const myChar = await defaultCharacterId(
        ctx.db,
        ctx.session.user.id,
        input.raidTeamId,
      ).catch(() => null);
      const events = await ctx.db.raidEvent.findMany({
        where: {
          raidTeamId: input.raidTeamId,
          startsAt: { gte: input.from, lt: input.to },
        },
        orderBy: { startsAt: "asc" },
        include: {
          signups: {
            select: {
              userId: true,
              characterId: true,
              state: true,
              etaMinutes: true,
            },
          },
        },
      });
      return {
        events: events.map((e) => {
          const counts = { CONFIRM: 0, TENTATIVE: 0, LATE: 0, ABSENT: 0 };
          let mine: { state: string; etaMinutes: number | null } | null = null;
          for (const s of e.signups) {
            counts[s.state as keyof typeof counts] += 1;
            if (myChar && s.characterId === myChar) {
              mine = { state: s.state, etaMinutes: s.etaMinutes };
            }
          }
          const present = counts.CONFIRM + counts.LATE;
          return {
            ...eventSummary(e),
            counts,
            present,
            responded: counts.CONFIRM + counts.TENTATIVE + counts.LATE + counts.ABSENT,
            myState: mine?.state ?? null,
            myEta: mine?.etaMinutes ?? null,
          };
        }),
      };
    }),

  /** One event with the full role-grouped roster, readiness, and own signup. */
  eventDetail: protectedProcedure
    .input(z.object({ eventId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const event = await ctx.db.raidEvent.findUnique({
        where: { id: input.eventId },
        include: { signups: true },
      });
      if (!event) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, event.raidTeamId, "MEMBER");
      const { compTemplate } = await teamTz(ctx.db, event.raidTeamId);

      // Active roster for the team (one row per active character).
      const memberships = await ctx.db.raidTeamMembership.findMany({
        where: { raidTeamId: event.raidTeamId, isActive: true },
        select: {
          character: { select: { id: true, name: true, classId: true, userId: true } },
        },
      });
      const charIds = memberships.map((m) => m.character.id);

      // Latest spec per character (for role grouping) — Blizzard summary snapshot.
      const specRows = charIds.length
        ? await ctx.db.characterSnapshot.findMany({
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

      const roster = buildRoster(members, parseComp(compTemplate));
      // Resolve "my" row via the same default-character logic setStatus writes
      // to, so the status control shows the char a click will actually update.
      const myChar = await defaultCharacterId(
        ctx.db,
        ctx.session.user.id,
        event.raidTeamId,
      ).catch(() => null);
      const mine =
        (myChar ? members.find((m) => m.characterId === myChar) : null) ??
        members.find((m) => m.userId === ctx.session.user.id) ??
        null;

      return {
        event: eventSummary(event),
        rosterLockedAt: event.rosterLockedAt,
        roster,
        mine: mine
          ? {
              characterId: mine.characterId,
              state: mine.state,
              etaMinutes: mine.etaMinutes,
              reason: mine.reason,
            }
          : null,
      };
    }),

  /**
   * Live-sync heartbeat for the browser: the team's current max outbox id.
   * A stable query key (just raidTeamId) makes this cheap to poll; the client
   * invalidates its calendar queries whenever this number grows. (The richer
   * `changesSince` cursor feed is for the Discord/companion fan-out + SSE.)
   */
  pulse: protectedProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "MEMBER");
      const latest = await ctx.db.syncOutbox.findFirst({
        where: { raidTeamId: input.raidTeamId },
        orderBy: { id: "desc" },
        select: { id: true },
      });
      return { maxId: latest ? latest.id.toString() : "0" };
    }),

  /** Cursor feed: outbox change descriptors with id > since (companion/SSE). */
  changesSince: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        since: z.string().default("0"), // BigInt as string
        limit: z.number().int().min(1).max(500).default(200),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "MEMBER");
      let sinceId: bigint;
      try {
        sinceId = BigInt(input.since);
      } catch {
        sinceId = BigInt(0);
      }
      const rows = await ctx.db.syncOutbox.findMany({
        where: { raidTeamId: input.raidTeamId, id: { gt: sinceId } },
        orderBy: { id: "asc" },
        take: input.limit,
        select: { id: true, kind: true, raidEventId: true },
      });
      const cursor =
        rows.length > 0 ? rows[rows.length - 1]!.id.toString() : input.since;
      return {
        cursor,
        changes: rows.map((r) => ({
          id: r.id.toString(),
          kind: r.kind,
          raidEventId: r.raidEventId,
        })),
      };
    }),

  // ─── Mutations ─────────────────────────────────────────────────────────

  /** Create a one-off event (recurrence lands in Phase 1). CO_LEADER+. */
  createEvent: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        title: z.string().trim().min(1).max(120),
        date: z.string().regex(ISO_DATE), // local date in team tz
        startTime: z.string().regex(HHMM), // local "HH:MM"
        durationMin: z.number().int().min(15).max(720),
        difficulty: difficultySchema,
        raidSize: z.number().int().min(1).max(40).optional(),
        notes: z.string().max(4000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "CO_LEADER");
      const { timezone } = await teamTz(ctx.db, input.raidTeamId);
      const startsAt = zonedWallClockToUtc(input.date, input.startTime, timezone);

      const event = await ctx.db.$transaction(async (tx) => {
        const e = await tx.raidEvent.create({
          data: {
            raidTeamId: input.raidTeamId,
            title: input.title,
            difficulty: input.difficulty,
            raidSize: input.raidSize ?? null,
            startsAt,
            durationMin: input.durationMin,
            timezone,
            localTime: input.startTime,
            occurrenceDate: input.date,
            notes: input.notes ?? null,
            createdByUserId: ctx.session.user.id,
          },
        });
        await appendOutbox(tx, {
          raidTeamId: input.raidTeamId,
          raidEventId: e.id,
          kind: "event.created",
          payload: { eventId: e.id },
          version: e.version,
          idempotencyKey: serverActionKey(),
        });
        return e;
      });

      await audit({
        event: "CALENDAR_EVENT_CREATED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidEvent",
        subjectId: event.id,
        metadata: { raidTeamId: input.raidTeamId, startsAt: startsAt.toISOString() },
      });
      return { id: event.id };
    }),

  /** Edit an event's fields. CO_LEADER+. */
  updateEvent: protectedProcedure
    .input(
      z.object({
        eventId: z.string().cuid(),
        title: z.string().trim().min(1).max(120).optional(),
        date: z.string().regex(ISO_DATE).optional(),
        startTime: z.string().regex(HHMM).optional(),
        durationMin: z.number().int().min(15).max(720).optional(),
        difficulty: difficultySchema.optional(),
        raidSize: z.number().int().min(1).max(40).nullable().optional(),
        notes: z.string().max(4000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const event = await ctx.db.raidEvent.findUnique({
        where: { id: input.eventId },
        select: {
          raidTeamId: true,
          timezone: true,
          occurrenceDate: true,
          localTime: true,
          version: true,
        },
      });
      if (!event) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, event.raidTeamId, "CO_LEADER");

      const data: Record<string, unknown> = {};
      if (input.title !== undefined) data.title = input.title;
      if (input.difficulty !== undefined) data.difficulty = input.difficulty;
      if (input.raidSize !== undefined) data.raidSize = input.raidSize;
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.durationMin !== undefined) data.durationMin = input.durationMin;

      // Date/time change → re-resolve startsAt in the event's own timezone.
      const newDate = input.date ?? event.occurrenceDate;
      const newTime = input.startTime ?? event.localTime;
      if (input.date !== undefined || input.startTime !== undefined) {
        data.occurrenceDate = newDate;
        data.localTime = newTime;
        data.startsAt = zonedWallClockToUtc(newDate, newTime, event.timezone);
      }

      await ctx.db.$transaction(async (tx) => {
        const e = await tx.raidEvent.update({
          where: { id: input.eventId },
          data: { ...data, version: { increment: 1 } },
          select: { version: true },
        });
        await appendOutbox(tx, {
          raidTeamId: event.raidTeamId,
          raidEventId: input.eventId,
          kind: "event.updated",
          payload: { eventId: input.eventId },
          version: e.version,
          idempotencyKey: serverActionKey(),
        });
      });

      await audit({
        event: "CALENDAR_EVENT_UPDATED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidEvent",
        subjectId: input.eventId,
        metadata: {},
      });
      return { ok: true };
    }),

  /** Cancel (soft — preserves history). LEADER+. */
  cancelEvent: protectedProcedure
    .input(z.object({ eventId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const event = await ctx.db.raidEvent.findUnique({
        where: { id: input.eventId },
        select: { raidTeamId: true },
      });
      if (!event) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, event.raidTeamId, "LEADER");

      await ctx.db.$transaction(async (tx) => {
        const e = await tx.raidEvent.update({
          where: { id: input.eventId },
          data: { status: "CANCELLED", version: { increment: 1 } },
          select: { version: true },
        });
        await appendOutbox(tx, {
          raidTeamId: event.raidTeamId,
          raidEventId: input.eventId,
          kind: "event.cancelled",
          payload: { eventId: input.eventId },
          version: e.version,
          idempotencyKey: serverActionKey(),
        });
      });

      await audit({
        event: "CALENDAR_EVENT_CANCELLED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidEvent",
        subjectId: input.eventId,
        metadata: {},
      });
      return { ok: true };
    }),

  /** Hard-delete a one-off event (LEADER+; prefer cancel for history). */
  deleteEvent: protectedProcedure
    .input(z.object({ eventId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const event = await ctx.db.raidEvent.findUnique({
        where: { id: input.eventId },
        select: { raidTeamId: true },
      });
      if (!event) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, event.raidTeamId, "LEADER");
      // Outbox row first so a poller learns of the removal, then delete
      // (cascade removes signups). Both in one TX.
      await ctx.db.$transaction(async (tx) => {
        await appendOutbox(tx, {
          raidTeamId: event.raidTeamId,
          raidEventId: input.eventId,
          kind: "event.cancelled",
          payload: { eventId: input.eventId, deleted: true },
          version: 0,
          idempotencyKey: serverActionKey(),
        });
        await tx.raidEvent.delete({ where: { id: input.eventId } });
      });
      await audit({
        event: "CALENDAR_EVENT_CANCELLED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidEvent",
        subjectId: input.eventId,
        metadata: { deleted: true },
      });
      return { ok: true };
    }),

  /** Set your own attendance status (idempotent intent). MEMBER. */
  setStatus: protectedProcedure
    .input(
      z.object({
        eventId: z.string().cuid(),
        state: stateSchema,
        etaMinutes: z.number().int().min(0).max(600).nullable().optional(),
        reason: z.string().max(500).nullable().optional(),
        comment: z.string().max(500).nullable().optional(),
        characterId: z.string().cuid().optional(),
        clientActionId: z.string().min(1).max(80),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const event = await ctx.db.raidEvent.findUnique({
        where: { id: input.eventId },
        select: {
          raidTeamId: true,
          startsAt: true,
          durationMin: true,
          status: true,
        },
      });
      if (!event) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, event.raidTeamId, "MEMBER");

      // Reject signups for an event that has already finished (M6).
      if (endInstant(event.startsAt, event.durationMin).getTime() < Date.now()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This raid has already finished.",
        });
      }
      if (event.status === "CANCELLED") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This raid was cancelled.",
        });
      }

      const characterId = await defaultCharacterId(
        ctx.db,
        ctx.session.user.id,
        event.raidTeamId,
        input.characterId,
      );
      const key = intentKey(ctx.session.user.id, input.eventId, input.clientActionId);

      const result = await ctx.db.$transaction(async (tx) => {
        // Idempotency: first writer wins; a replay is a no-op.
        const claimed = await tx.processedIntent.createMany({
          data: { idempotencyKey: key, raidEventId: input.eventId, userId: ctx.session.user.id },
          skipDuplicates: true,
        });
        if (claimed.count === 0) {
          return { applied: false as const };
        }
        const signup = await tx.eventSignup.upsert({
          where: { raidEventId_characterId: { raidEventId: input.eventId, characterId } },
          create: {
            raidEventId: input.eventId,
            userId: ctx.session.user.id,
            characterId,
            state: input.state,
            etaMinutes: input.state === "LATE" ? (input.etaMinutes ?? null) : null,
            reason: input.reason ?? null,
            comment: input.comment ?? null,
            source: "WEBSITE",
            updatedByUserId: ctx.session.user.id,
          },
          update: {
            state: input.state,
            etaMinutes: input.state === "LATE" ? (input.etaMinutes ?? null) : null,
            reason: input.reason ?? null,
            comment: input.comment ?? null,
            source: "WEBSITE",
            updatedByUserId: ctx.session.user.id,
            version: { increment: 1 },
          },
          select: { version: true },
        });
        await appendOutbox(tx, {
          raidTeamId: event.raidTeamId,
          raidEventId: input.eventId,
          kind: "signup.changed",
          payload: { eventId: input.eventId, characterId, state: input.state },
          version: signup.version,
          idempotencyKey: key,
        });
        return { applied: true as const, characterId };
      });

      await audit({
        event: "CALENDAR_SIGNUP_CHANGED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidEvent",
        subjectId: input.eventId,
        metadata: { state: input.state, characterId, source: "WEBSITE" },
      });
      return { ok: true, applied: result.applied, characterId };
    }),

  /** Leader sets a member's status on their behalf (source=LEADER). CO_LEADER+. */
  setStatusForMember: protectedProcedure
    .input(
      z.object({
        eventId: z.string().cuid(),
        characterId: z.string().cuid(),
        state: stateSchema,
        etaMinutes: z.number().int().min(0).max(600).nullable().optional(),
        reason: z.string().max(500).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const event = await ctx.db.raidEvent.findUnique({
        where: { id: input.eventId },
        select: { raidTeamId: true, startsAt: true, durationMin: true, status: true },
      });
      if (!event) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, event.raidTeamId, "CO_LEADER");

      // Same guards as setStatus (M6): never write attendance on a finished or
      // cancelled raid — a stale CONFIRM there would skew the attendance ledger.
      if (endInstant(event.startsAt, event.durationMin).getTime() < Date.now()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This raid has already finished." });
      }
      if (event.status === "CANCELLED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This raid was cancelled." });
      }

      // Target character must be an active member of THIS team (B4 spirit).
      const target = await ctx.db.raidTeamMembership.findFirst({
        where: { raidTeamId: event.raidTeamId, characterId: input.characterId, isActive: true },
        select: { character: { select: { userId: true } } },
      });
      if (!target) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That character is not on this raid team.",
        });
      }

      await ctx.db.$transaction(async (tx) => {
        const signup = await tx.eventSignup.upsert({
          where: { raidEventId_characterId: { raidEventId: input.eventId, characterId: input.characterId } },
          create: {
            raidEventId: input.eventId,
            userId: target.character.userId,
            characterId: input.characterId,
            state: input.state,
            etaMinutes: input.state === "LATE" ? (input.etaMinutes ?? null) : null,
            reason: input.reason ?? null,
            source: "LEADER",
            updatedByUserId: ctx.session.user.id,
          },
          update: {
            state: input.state,
            etaMinutes: input.state === "LATE" ? (input.etaMinutes ?? null) : null,
            reason: input.reason ?? null,
            source: "LEADER",
            updatedByUserId: ctx.session.user.id,
            version: { increment: 1 },
          },
          select: { version: true },
        });
        await appendOutbox(tx, {
          raidTeamId: event.raidTeamId,
          raidEventId: input.eventId,
          kind: "signup.changed",
          payload: { eventId: input.eventId, characterId: input.characterId, state: input.state },
          version: signup.version,
          idempotencyKey: serverActionKey(),
        });
      });
      await audit({
        event: "CALENDAR_SIGNUP_CHANGED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidEvent",
        subjectId: input.eventId,
        metadata: { state: input.state, characterId: input.characterId, source: "LEADER" },
      });
      return { ok: true };
    }),

  /** Lock / unlock the roster (final selection). LEADER+. */
  setLock: protectedProcedure
    .input(z.object({ eventId: z.string().cuid(), locked: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const event = await ctx.db.raidEvent.findUnique({
        where: { id: input.eventId },
        select: { raidTeamId: true, status: true },
      });
      if (!event) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, event.raidTeamId, "LEADER");
      if (event.status === "CANCELLED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Event is cancelled." });
      }
      await ctx.db.$transaction(async (tx) => {
        const e = await tx.raidEvent.update({
          where: { id: input.eventId },
          data: {
            status: input.locked ? "LOCKED" : "PLANNED",
            rosterLockedAt: input.locked ? new Date() : null,
            version: { increment: 1 },
          },
          select: { version: true },
        });
        await appendOutbox(tx, {
          raidTeamId: event.raidTeamId,
          raidEventId: input.eventId,
          kind: "event.updated",
          payload: { eventId: input.eventId, locked: input.locked },
          version: e.version,
          idempotencyKey: serverActionKey(),
        });
      });
      await audit({
        event: "CALENDAR_ROSTER_LOCKED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidEvent",
        subjectId: input.eventId,
        metadata: { locked: input.locked },
      });
      return { ok: true };
    }),

  /** Final-selection bucket for a signed-up character (Starter/Bench/Cut). LEADER+. */
  setSelection: protectedProcedure
    .input(
      z.object({
        eventId: z.string().cuid(),
        characterId: z.string().cuid(),
        selection: z.enum(["STARTER", "BENCH", "CUT"]).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const event = await ctx.db.raidEvent.findUnique({
        where: { id: input.eventId },
        select: { raidTeamId: true },
      });
      if (!event) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, event.raidTeamId, "LEADER");
      const signup = await ctx.db.eventSignup.findUnique({
        where: { raidEventId_characterId: { raidEventId: input.eventId, characterId: input.characterId } },
        select: { id: true },
      });
      if (!signup) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That character has no signup on this event yet.",
        });
      }
      await ctx.db.$transaction(async (tx) => {
        const s = await tx.eventSignup.update({
          where: { raidEventId_characterId: { raidEventId: input.eventId, characterId: input.characterId } },
          data: { selection: input.selection, version: { increment: 1 } },
          select: { version: true },
        });
        await appendOutbox(tx, {
          raidTeamId: event.raidTeamId,
          raidEventId: input.eventId,
          kind: "signup.changed",
          payload: { eventId: input.eventId, characterId: input.characterId, selection: input.selection },
          version: s.version,
          idempotencyKey: serverActionKey(),
        });
      });
      return { ok: true };
    }),

  /** Team calendar settings: home timezone + comp template. LEADER+. */
  setSettings: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        timezone: z.string().max(64).optional(),
        comp: z
          .object({
            tanks: z.number().int().min(0).max(40),
            healers: z.number().int().min(0).max(40),
            dps: z.number().int().min(0).max(40),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "LEADER");
      const data: Record<string, unknown> = {};
      if (input.timezone !== undefined) {
        if (!isValidTimeZone(input.timezone)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown timezone." });
        }
        data.timezone = input.timezone;
      }
      if (input.comp !== undefined) data.compTemplate = input.comp;
      await ctx.db.raidTeam.update({ where: { id: input.raidTeamId }, data });
      return { ok: true };
    }),

  /** Signup-based attendance history per character (F5; observed-presence later). */
  attendanceLedger: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        windowDays: z.number().int().min(7).max(180).default(28),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "MEMBER");
      const since = new Date(Date.now() - input.windowDays * 86400000);
      const now = new Date();

      // Past, non-cancelled scheduled events in the window = the denominator.
      const events = await ctx.db.raidEvent.findMany({
        where: {
          raidTeamId: input.raidTeamId,
          startsAt: { gte: since, lt: now },
          status: { not: "CANCELLED" },
        },
        select: { id: true },
      });
      const eventIds = events.map((e) => e.id);
      const totalEvents = eventIds.length;

      const memberships = await ctx.db.raidTeamMembership.findMany({
        where: { raidTeamId: input.raidTeamId, isActive: true },
        select: { character: { select: { id: true, name: true, classId: true } } },
      });

      const signups = eventIds.length
        ? await ctx.db.eventSignup.findMany({
            where: { raidEventId: { in: eventIds } },
            select: { characterId: true, state: true },
          })
        : [];
      const byChar = new Map<string, { confirm: number; late: number; tentative: number; absent: number; responded: number }>();
      for (const s of signups) {
        const c = byChar.get(s.characterId) ?? { confirm: 0, late: 0, tentative: 0, absent: 0, responded: 0 };
        c.responded += 1;
        if (s.state === "CONFIRM") c.confirm += 1;
        else if (s.state === "LATE") c.late += 1;
        else if (s.state === "TENTATIVE") c.tentative += 1;
        else if (s.state === "ABSENT") c.absent += 1;
        byChar.set(s.characterId, c);
      }

      return {
        totalEvents,
        windowDays: input.windowDays,
        rows: memberships
          .map((m) => {
            const c = m.character;
            const s = byChar.get(c.id) ?? { confirm: 0, late: 0, tentative: 0, absent: 0, responded: 0 };
            const present = s.confirm + s.late;
            return {
              characterId: c.id,
              name: c.name,
              classId: c.classId,
              present,
              ...s,
              noResponse: totalEvents - s.responded,
              // % is over scheduled events (signup-based; observed-presence later).
              attendancePct: totalEvents > 0 ? Math.round((present / totalEvents) * 100) : null,
            };
          })
          .sort((a, b) => (b.attendancePct ?? -1) - (a.attendancePct ?? -1) || a.name.localeCompare(b.name)),
      };
    }),
});
