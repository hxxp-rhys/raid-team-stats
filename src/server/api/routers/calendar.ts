import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  router,
  protectedProcedure,
  publicProcedure,
  assertRaidTeamRole,
} from "@/server/api/trpc";
import type { ExtendedPrismaClient } from "@/lib/db";
import { env } from "@/env";
import { logger } from "@/lib/logger";
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
  localDateInTz,
  zonedWallClockToUtc,
} from "@/lib/calendar/time";
import {
  enumerateOccurrences,
  isValidByday,
  type SeriesSpec,
} from "@/lib/calendar/occurrence";
import { reconcileSeries, type ReconcilePlan } from "@/lib/calendar/series";
import {
  deriveTargetArrays,
  parseRaidTargetOrder,
  raidTargetOrderSchema,
} from "@/lib/calendar/raid-target";
import {
  createCalendarShareToken,
  verifyCalendarShareToken,
} from "@/server/security/calendar-share-token";
import {
  MAX_LEAD_MINUTES,
  parseReminderConfig,
} from "@/lib/calendar/reminder-policy";
import {
  materializeSeries,
  MATERIALIZE_HORIZON_DAYS,
} from "@/server/calendar/materialize";
import {
  appendOutbox,
  intentKey,
  serverActionKey,
} from "@/server/calendar/sync";
import { applySignupIntent } from "@/server/calendar/signup-intent";
import { removeEventBoard } from "@/server/calendar/discord/render";
import {
  getZoneArtUrl,
  getZoneEncounters,
  CURRENT_TIER_INSTANCES,
} from "@/server/calendar/zone-art";

const stateSchema = z.enum(["CONFIRM", "TENTATIVE", "LATE", "ABSENT"]);
const difficultySchema = z.enum(["Mythic", "Heroic", "Normal", "LFR"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{1,2}:\d{2}$/;

/** Team home timezone, defaulting to UTC. */
async function teamTz(
  db: ExtendedPrismaClient,
  raidTeamId: string,
): Promise<{ timezone: string; compTemplate: unknown; reminderConfig: unknown }> {
  const t = await db.raidTeam.findUnique({
    where: { id: raidTeamId },
    select: { timezone: true, compTemplate: true, reminderConfig: true },
  });
  return {
    timezone: t?.timezone && isValidTimeZone(t.timezone) ? t.timezone : "UTC",
    compTemplate: t?.compTemplate ?? null,
    reminderConfig: t?.reminderConfig ?? null,
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
  targetOrder: unknown;
  targetZoneIds: number[];
  targetEncounterIds: number[];
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
    targetOrder: parseRaidTargetOrder(e.targetOrder),
    targetZoneIds: e.targetZoneIds,
    targetEncounterIds: e.targetEncounterIds,
    version: e.version,
  };
}

const bydaySchema = z
  .array(z.string())
  .min(1)
  .max(7)
  .refine((arr) => arr.every(isValidByday), "invalid BYDAY token");

const reminderConfigSchema = z.object({
  enabled: z.boolean(),
  // Capped at MAX_LEAD_MINUTES so every accepted value is within the reminder
  // sweep's lookahead — a config the sweep could never deliver is unstorable.
  leadMinutes: z.array(z.number().int().min(5).max(MAX_LEAD_MINUTES)).max(6),
  // Multiple non-responder nudges, each at the lead's discretion. Bounded count
  // to keep the stored config + per-event mail volume sane.
  nudgeMinutes: z.array(z.number().int().min(5).max(MAX_LEAD_MINUTES)).max(6),
  // Optional custom nudge email (subject + body with {{ placeholder }} tokens).
  // Omitted/empty = built-in default copy. Caps mirror reminder-policy.
  nudgeTemplate: z
    .object({
      subject: z.string().max(200).optional(),
      body: z.string().max(4000).optional(),
    })
    .optional(),
});

/** Series fields the per-occurrence rows inherit (everything but the schedule). */
type SeriesFields = {
  id: string;
  raidTeamId: string;
  title: string;
  difficulty: string;
  raidSize: number | null;
  durationMin: number;
  notes: string | null;
  targetOrder: unknown;
  targetZoneIds: number[];
  targetEncounterIds: number[];
  createdByUserId: string | null;
};

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

/**
 * Apply a reconcile plan (from `reconcileSeries`) to the database: create new
 * occurrences, re-time/refresh kept ones, soft-cancel de-scheduled ones with
 * signups, and hard-delete empty de-scheduled placeholders — each in its own
 * transaction with an outbox row so browsers/consumers see every change.
 */
async function applySeriesPlan(
  db: ExtendedPrismaClient,
  series: SeriesFields,
  plan: ReconcilePlan,
): Promise<{ created: number; updated: number; cancelled: number; deleted: number }> {
  // Authoritative ordered target list, copied to every occurrence alongside the
  // derived flat arrays already stored on the series.
  const seriesTargetOrder = parseRaidTargetOrder(series.targetOrder);
  let created = 0;
  let updated = 0;
  let cancelled = 0;
  let deleted = 0;

  for (const o of plan.toCreate) {
    try {
      await db.$transaction(async (tx) => {
        const e = await tx.raidEvent.create({
          data: {
            raidTeamId: series.raidTeamId,
            seriesId: series.id,
            title: series.title,
            difficulty: series.difficulty,
            raidSize: series.raidSize,
            startsAt: o.startsAt,
            durationMin: series.durationMin,
            timezone: o.timezone,
            localTime: o.localTime,
            occurrenceDate: o.occurrenceDate,
            notes: series.notes,
            targetOrder: seriesTargetOrder,
            targetZoneIds: series.targetZoneIds,
            targetEncounterIds: series.targetEncounterIds,
            createdByUserId: series.createdByUserId,
          },
          select: { id: true, version: true },
        });
        await appendOutbox(tx, {
          raidTeamId: series.raidTeamId,
          raidEventId: e.id,
          kind: "event.created",
          payload: { eventId: e.id, seriesId: series.id },
          version: e.version,
          idempotencyKey: serverActionKey(),
        });
      });
      created++;
    } catch (err) {
      if (isUniqueViolation(err)) continue; // raced a sweep — fine
      logger.warn({ err, seriesId: series.id }, "applySeriesPlan: create failed");
    }
  }

  for (const u of plan.toUpdate) {
    await db.$transaction(async (tx) => {
      const e = await tx.raidEvent.update({
        where: { id: u.id },
        data: {
          title: series.title,
          difficulty: series.difficulty,
          raidSize: series.raidSize,
          notes: series.notes,
          targetOrder: seriesTargetOrder,
          targetZoneIds: series.targetZoneIds,
          targetEncounterIds: series.targetEncounterIds,
          durationMin: series.durationMin,
          timezone: u.occurrence.timezone,
          localTime: u.occurrence.localTime,
          startsAt: u.occurrence.startsAt,
          version: { increment: 1 },
        },
        select: { version: true },
      });
      await appendOutbox(tx, {
        raidTeamId: series.raidTeamId,
        raidEventId: u.id,
        kind: "event.updated",
        payload: { eventId: u.id, seriesId: series.id },
        version: e.version,
        idempotencyKey: serverActionKey(),
      });
    });
    updated++;
  }

  for (const id of plan.toCancel) {
    await db.$transaction(async (tx) => {
      const e = await tx.raidEvent.update({
        where: { id },
        data: { status: "CANCELLED", version: { increment: 1 } },
        select: { version: true },
      });
      await appendOutbox(tx, {
        raidTeamId: series.raidTeamId,
        raidEventId: id,
        kind: "event.cancelled",
        payload: { eventId: id, seriesId: series.id },
        version: e.version,
        idempotencyKey: serverActionKey(),
      });
    });
    cancelled++;
  }

  for (const id of plan.toDelete) {
    const linkage = await db.raidEvent.findUnique({
      where: { id },
      select: { discordChannelId: true, discordMessageId: true },
    });
    await db.$transaction(async (tx) => {
      await appendOutbox(tx, {
        raidTeamId: series.raidTeamId,
        raidEventId: id,
        kind: "event.cancelled",
        payload: { eventId: id, seriesId: series.id, deleted: true },
        version: 0,
        idempotencyKey: serverActionKey(),
      });
      await tx.raidEvent.delete({ where: { id } });
    });
    // Best-effort: remove any posted Discord board for the deleted placeholder.
    await removeEventBoard(linkage?.discordChannelId, linkage?.discordMessageId);
    deleted++;
  }

  return { created, updated, cancelled, deleted };
}

/**
 * Current tier's targetable raid zones (+ bosses + tile art). Shared by the
 * raid-lead picker query and the public calendar-share shell.
 */
async function resolveTargetableZones() {
  return Promise.all(
    Object.entries(CURRENT_TIER_INSTANCES).map(
      async ([name, blizzardInstanceId]) => ({
        blizzardInstanceId,
        name,
        encounters: await getZoneEncounters(blizzardInstanceId).catch(() => []),
        imageUrl: await getZoneArtUrl(blizzardInstanceId).catch(() => null),
      }),
    ),
  );
}

/**
 * Verify + authorize a calendar share token. Two-mode (mirrors the dashboard
 * share): a PUBLIC calendar is readable by anyone holding a valid token; a
 * private one only routes — the caller must still be a signed-in active member.
 * Throws on a bad/expired token or denied access. Returns the resolved team
 * plus the token's default view + expiry.
 */
async function resolveSharedCalendarTeam(
  ctx: Parameters<typeof assertRaidTeamRole>[0],
  token: string,
) {
  const verified = verifyCalendarShareToken(token);
  if (!verified) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This share link is invalid or has expired.",
    });
  }
  const team = await ctx.db.raidTeam.findUnique({
    where: { id: verified.raidTeamId },
    select: {
      id: true,
      name: true,
      guildId: true,
      timezone: true,
      calendarShareIsPublic: true,
    },
  });
  if (!team) throw new TRPCError({ code: "NOT_FOUND" });
  if (!team.calendarShareIsPublic) {
    // Private: the token only routes — require a signed-in active member.
    if (!ctx.session?.user?.id) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message:
          "This calendar isn't public. Sign in as a team member to view it.",
      });
    }
    await assertRaidTeamRole(ctx, verified.raidTeamId, "MEMBER");
  }
  return {
    raidTeamId: team.id,
    name: team.name,
    guildId: team.guildId,
    timezone: team.timezone,
    calendarShareIsPublic: team.calendarShareIsPublic,
    expiresAt: verified.expiresAt,
    view: verified.view,
  };
}

export const calendarRouter = router({
  /** Team calendar settings + the caller's role (for gating the UI). */
  meta: protectedProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "MEMBER");
      const { timezone, compTemplate, reminderConfig } = await teamTz(
        ctx.db,
        input.raidTeamId,
      );
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
      return {
        timezone,
        comp: parseComp(compTemplate),
        reminders: parseReminderConfig(reminderConfig),
        role,
      };
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

  /** Active recurring series for a team (for the schedules manager). MEMBER. */
  listSeries: protectedProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "MEMBER");
      const series = await ctx.db.raidEventSeries.findMany({
        where: { raidTeamId: input.raidTeamId, isActive: true },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          title: true,
          difficulty: true,
          raidSize: true,
          byday: true,
          startLocal: true,
          durationMin: true,
          timezone: true,
          notes: true,
          endsOn: true,
        },
      });
      return { series };
    }),

  /**
   * The current tier's raid ZONES (Blizzard journal-instances) + their bosses
   * + official tile art, for the raid-lead event-targeting picker and the
   * month-view zone-art day backgrounds. MEMBER.
   *
   * Zones come from a STATIC current-tier instance map (name → Blizzard id);
   * encounter names come from WclParseSnapshot distinct rows (read-only, no WCL
   * points). The art URL is resolved+cached per instance (7-day Redis TTL) and
   * is null when the tier isn't released / media 404s — the cell then falls
   * back to its difficulty tint. The WCL zone is resolved only to scope the
   * encounter lookup; missing/unmapped data never blocks the response.
   */
  targetableZones: protectedProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "MEMBER");

      // Each raid's OWN bosses + art come from its Blizzard journal-instance
      // (both static per patch + Redis-cached). This is what makes the picker
      // show the SELECTED raid's bosses — WCL lumps the whole tier into one
      // combined zone whose encounter list can't separate the raids.
      return { zones: await resolveTargetableZones() };
    }),

  // ─── Calendar sharing (read-only public links) ──────────────────────────

  /** Issue a signed read-only share link for the team calendar. CO_LEADER+. */
  createCalendarShareLink: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        view: z.enum(["agenda", "month"]),
        ttlDays: z.number().int().min(1).max(366).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "CO_LEADER");
      const { token, expiresAt } = createCalendarShareToken({
        raidTeamId: input.raidTeamId,
        view: input.view,
        ttlDays: input.ttlDays ?? null,
      });
      const url = `${env.APP_URL}/share/calendar/${encodeURIComponent(token)}`;
      logger.info(
        { raidTeamId: input.raidTeamId, view: input.view, expiresAt },
        "calendar: share link issued",
      );
      return { token, url, expiresAt };
    }),

  /** Current calendar-share public flag. CO_LEADER+. */
  calendarShareSettings: protectedProcedure
    .input(z.object({ raidTeamId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "CO_LEADER");
      const team = await ctx.db.raidTeam.findUnique({
        where: { id: input.raidTeamId },
        select: { calendarShareIsPublic: true },
      });
      if (!team) throw new TRPCError({ code: "NOT_FOUND" });
      return { isPublic: team.calendarShareIsPublic };
    }),

  /** Toggle anonymous read access for valid share links. CO_LEADER+. */
  setCalendarSharePublic: protectedProcedure
    .input(z.object({ raidTeamId: z.string().cuid(), isPublic: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "CO_LEADER");
      await ctx.db.raidTeam.update({
        where: { id: input.raidTeamId },
        data: { calendarShareIsPublic: input.isPublic },
      });
      return { ok: true, isPublic: input.isPublic };
    }),

  /**
   * PUBLIC: calendar shell for a share link — team name, timezone, the link's
   * default view, and the zone art for month tiles. Token-authorized via
   * resolveSharedCalendarTeam (public calendar → anyone; private → members).
   */
  shareMeta: publicProcedure
    .input(z.object({ token: z.string().min(1).max(2048) }))
    .query(async ({ ctx, input }) => {
      const team = await resolveSharedCalendarTeam(ctx, input.token);
      return {
        teamName: team.name,
        guildId: team.guildId,
        timezone: team.timezone ?? "UTC",
        view: team.view,
        isPublic: team.calendarShareIsPublic,
        expiresAt: team.expiresAt,
        zones: await resolveTargetableZones(),
      };
    }),

  /**
   * PUBLIC: events in [from,to] for a share link — read-only. NO per-user
   * state (no myState, no signup identities); only aggregate present/responded
   * counts. The window is bounded so a link can't pull an unbounded range.
   */
  shareEvents: publicProcedure
    .input(
      z.object({
        token: z.string().min(1).max(2048),
        from: z.date(),
        to: z.date(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const team = await resolveSharedCalendarTeam(ctx, input.token);
      if (input.to <= input.from) return { events: [] };
      const MAX_RANGE_MS = 120 * 86_400_000;
      const to =
        input.to.getTime() - input.from.getTime() > MAX_RANGE_MS
          ? new Date(input.from.getTime() + MAX_RANGE_MS)
          : input.to;
      const events = await ctx.db.raidEvent.findMany({
        where: {
          raidTeamId: team.raidTeamId,
          startsAt: { gte: input.from, lt: to },
        },
        orderBy: { startsAt: "asc" },
        include: { signups: { select: { state: true } } },
      });
      return {
        events: events.map((e) => {
          let present = 0;
          let responded = 0;
          for (const s of e.signups) {
            if (s.state === "CONFIRM" || s.state === "LATE") present++;
            if (
              s.state === "CONFIRM" ||
              s.state === "TENTATIVE" ||
              s.state === "LATE" ||
              s.state === "ABSENT"
            ) {
              responded++;
            }
          }
          return {
            id: e.id,
            title: e.title,
            difficulty: e.difficulty,
            raidSize: e.raidSize,
            startsAt: e.startsAt,
            endsAt: endInstant(e.startsAt, e.durationMin),
            durationMin: e.durationMin,
            status: e.status,
            seriesId: e.seriesId,
            targetOrder: parseRaidTargetOrder(e.targetOrder),
            targetZoneIds: e.targetZoneIds,
            present,
            responded,
          };
        }),
      };
    }),

  // ─── Mutations ─────────────────────────────────────────────────────────

  /** Create a one-off event. CO_LEADER+. (Recurring → createSeries.) */
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
        targetOrder: raidTargetOrderSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "CO_LEADER");
      const { timezone } = await teamTz(ctx.db, input.raidTeamId);
      const startsAt = zonedWallClockToUtc(input.date, input.startTime, timezone);
      const targetOrder = input.targetOrder ?? [];
      const { targetZoneIds, targetEncounterIds } = deriveTargetArrays(targetOrder);

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
            targetOrder,
            targetZoneIds,
            targetEncounterIds,
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

  /**
   * Create a recurring weekly series and immediately materialize the horizon.
   * CO_LEADER+. `byday` = RFC5545 tokens (["TU","TH"]); times are wall-clock in
   * the team timezone, so they stay put across DST.
   */
  createSeries: protectedProcedure
    .input(
      z.object({
        raidTeamId: z.string().cuid(),
        title: z.string().trim().min(1).max(120),
        byday: bydaySchema,
        startTime: z.string().regex(HHMM),
        durationMin: z.number().int().min(15).max(720),
        difficulty: difficultySchema,
        raidSize: z.number().int().min(1).max(40).optional(),
        notes: z.string().max(4000).optional(),
        targetOrder: raidTargetOrderSchema.optional(),
        startDate: z.string().regex(ISO_DATE),
        endDate: z.string().regex(ISO_DATE).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertRaidTeamRole(ctx, input.raidTeamId, "CO_LEADER");
      const { timezone } = await teamTz(ctx.db, input.raidTeamId);
      if (input.endDate && input.endDate < input.startDate) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Series end date is before its start date.",
        });
      }
      const startsOn = zonedWallClockToUtc(input.startDate, input.startTime, timezone);
      const endsOn = input.endDate
        ? zonedWallClockToUtc(input.endDate, input.startTime, timezone)
        : null;
      const targetOrder = input.targetOrder ?? [];
      const { targetZoneIds, targetEncounterIds } = deriveTargetArrays(targetOrder);

      const series = await ctx.db.raidEventSeries.create({
        data: {
          raidTeamId: input.raidTeamId,
          title: input.title,
          difficulty: input.difficulty,
          byday: input.byday.map((b) => b.toUpperCase()),
          startLocal: input.startTime,
          durationMin: input.durationMin,
          timezone,
          raidSize: input.raidSize ?? null,
          notes: input.notes ?? null,
          targetOrder,
          targetZoneIds,
          targetEncounterIds,
          startsOn,
          endsOn,
          createdByUserId: ctx.session.user.id,
          isActive: true,
        },
        select: { id: true },
      });
      const { created } = await materializeSeries(ctx.db, series.id);

      await audit({
        event: "CALENDAR_EVENT_CREATED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidEventSeries",
        subjectId: series.id,
        metadata: {
          raidTeamId: input.raidTeamId,
          recurring: true,
          byday: input.byday,
          created,
        },
      });
      return { seriesId: series.id, created };
    }),

  /**
   * Edit a series and propagate to its FUTURE occurrences (past ones are never
   * touched). Pinned/locked/cancelled occurrences are left alone; de-scheduled
   * occurrences with signups are cancelled (history kept), empty ones deleted.
   * CO_LEADER+.
   */
  updateSeries: protectedProcedure
    .input(
      z.object({
        seriesId: z.string().cuid(),
        title: z.string().trim().min(1).max(120).optional(),
        byday: bydaySchema.optional(),
        startTime: z.string().regex(HHMM).optional(),
        durationMin: z.number().int().min(15).max(720).optional(),
        difficulty: difficultySchema.optional(),
        raidSize: z.number().int().min(1).max(40).nullable().optional(),
        notes: z.string().max(4000).nullable().optional(),
        targetOrder: raidTargetOrderSchema.optional(),
        endDate: z.string().regex(ISO_DATE).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing0 = await ctx.db.raidEventSeries.findUnique({
        where: { id: input.seriesId },
        select: {
          raidTeamId: true,
          startLocal: true,
          timezone: true,
          startsOn: true,
          endsOn: true,
        },
      });
      if (!existing0) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, existing0.raidTeamId, "CO_LEADER");

      const tz = existing0.timezone;
      const effectiveTime = input.startTime ?? existing0.startLocal;

      const data: Record<string, unknown> = {};
      if (input.title !== undefined) data.title = input.title;
      if (input.difficulty !== undefined) data.difficulty = input.difficulty;
      if (input.raidSize !== undefined) data.raidSize = input.raidSize;
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.targetOrder !== undefined) {
        const derived = deriveTargetArrays(input.targetOrder);
        data.targetOrder = input.targetOrder;
        data.targetZoneIds = derived.targetZoneIds;
        data.targetEncounterIds = derived.targetEncounterIds;
      }
      if (input.durationMin !== undefined) data.durationMin = input.durationMin;
      if (input.byday !== undefined) data.byday = input.byday.map((b) => b.toUpperCase());
      if (input.startTime !== undefined) data.startLocal = input.startTime;

      // startsOn/endsOn are stored as the start *instant* of the first/last
      // occurrence, so they're time-sensitive: a startTime change must re-derive
      // both (at their same local dates) or enumerateOccurrences would wrongly
      // drop the boundary occurrences. endDate also re-derives endsOn.
      const startDateStr = existing0.startsOn
        ? localDateInTz(existing0.startsOn, tz)
        : null;
      if (input.startTime !== undefined && startDateStr) {
        data.startsOn = zonedWallClockToUtc(startDateStr, effectiveTime, tz);
      }
      if (input.endDate !== undefined || input.startTime !== undefined) {
        const endDateStr =
          input.endDate !== undefined
            ? input.endDate
            : existing0.endsOn
              ? localDateInTz(existing0.endsOn, tz)
              : null;
        if (endDateStr) {
          const endsOn = zonedWallClockToUtc(endDateStr, effectiveTime, tz);
          // Guard (mirrors createSeries): an end before the start would make
          // enumerateOccurrences return [] and silently wipe every occurrence.
          const startBound = (data.startsOn as Date | undefined) ?? existing0.startsOn;
          if (startBound && endsOn.getTime() < startBound.getTime()) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Series end date is before its start date.",
            });
          }
          data.endsOn = endsOn;
        } else if (input.endDate !== undefined) {
          data.endsOn = null; // explicitly cleared → open-ended
        }
      }

      const series = await ctx.db.raidEventSeries.update({
        where: { id: input.seriesId },
        data,
        select: {
          id: true,
          raidTeamId: true,
          title: true,
          difficulty: true,
          raidSize: true,
          durationMin: true,
          notes: true,
          targetOrder: true,
          targetZoneIds: true,
          targetEncounterIds: true,
          createdByUserId: true,
          byday: true,
          startLocal: true,
          timezone: true,
          startsOn: true,
          endsOn: true,
          isActive: true,
        },
      });

      const now = new Date();
      const horizonEnd = new Date(now.getTime() + MATERIALIZE_HORIZON_DAYS * 86_400_000);
      const spec: SeriesSpec = {
        byday: series.byday,
        startLocal: series.startLocal,
        timezone: series.timezone,
        startsOn: series.startsOn,
        endsOn: series.endsOn,
      };
      const desired = series.isActive ? enumerateOccurrences(spec, now, horizonEnd) : [];

      const futureEvents = await ctx.db.raidEvent.findMany({
        where: { seriesId: series.id, startsAt: { gte: now } },
        select: {
          id: true,
          occurrenceDate: true,
          seriesOverride: true,
          status: true,
          _count: { select: { signups: true } },
        },
      });
      const plan = reconcileSeries(
        desired,
        futureEvents.map((e) => ({
          id: e.id,
          occurrenceDate: e.occurrenceDate,
          seriesOverride: e.seriesOverride,
          status: e.status,
          signupCount: e._count.signups,
        })),
      );
      const res = await applySeriesPlan(ctx.db, series, plan);

      await audit({
        event: "CALENDAR_EVENT_UPDATED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidEventSeries",
        subjectId: series.id,
        metadata: { recurring: true, ...res },
      });
      return { ok: true, ...res };
    }),

  /**
   * Stop a recurring series: deactivate it and clear its FUTURE occurrences
   * (cancel ones with signups, delete empty placeholders; pinned/locked/
   * already-cancelled left as-is). Past occurrences are preserved. LEADER+.
   */
  endSeries: protectedProcedure
    .input(z.object({ seriesId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const series = await ctx.db.raidEventSeries.findUnique({
        where: { id: input.seriesId },
        select: {
          id: true,
          raidTeamId: true,
          title: true,
          difficulty: true,
          raidSize: true,
          durationMin: true,
          notes: true,
          targetOrder: true,
          targetZoneIds: true,
          targetEncounterIds: true,
          createdByUserId: true,
        },
      });
      if (!series) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, series.raidTeamId, "LEADER");

      await ctx.db.raidEventSeries.update({
        where: { id: input.seriesId },
        data: { isActive: false },
      });

      const now = new Date();
      const futureEvents = await ctx.db.raidEvent.findMany({
        where: { seriesId: series.id, startsAt: { gte: now } },
        select: {
          id: true,
          occurrenceDate: true,
          seriesOverride: true,
          status: true,
          _count: { select: { signups: true } },
        },
      });
      const plan = reconcileSeries(
        [],
        futureEvents.map((e) => ({
          id: e.id,
          occurrenceDate: e.occurrenceDate,
          seriesOverride: e.seriesOverride,
          status: e.status,
          signupCount: e._count.signups,
        })),
      );
      const res = await applySeriesPlan(ctx.db, series, plan);

      await audit({
        event: "CALENDAR_EVENT_CANCELLED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidEventSeries",
        subjectId: series.id,
        metadata: { ended: true, ...res },
      });
      return { ok: true, ...res };
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
        targetOrder: raidTargetOrderSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const event = await ctx.db.raidEvent.findUnique({
        where: { id: input.eventId },
        select: {
          raidTeamId: true,
          seriesId: true,
          timezone: true,
          occurrenceDate: true,
          localTime: true,
          version: true,
        },
      });
      if (!event) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, event.raidTeamId, "CO_LEADER");

      // A recurring occurrence's DATE is fixed: moving it would vacate its
      // (seriesId, occurrenceDate) slot, which the next materialize sweep would
      // refill with a duplicate placeholder (and moving onto a sibling's date
      // would hit the unique key). The time/title/etc. are still editable.
      if (
        event.seriesId &&
        input.date !== undefined &&
        input.date !== event.occurrenceDate
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "A recurring occurrence can't move to a different date — cancel it and add a one-off raid instead.",
        });
      }

      const data: Record<string, unknown> = {};
      // Editing a single occurrence of a series PINS it: the materializer and
      // future series-level edits must never overwrite this customized night.
      if (event.seriesId) data.seriesOverride = true;
      if (input.title !== undefined) data.title = input.title;
      if (input.difficulty !== undefined) data.difficulty = input.difficulty;
      if (input.raidSize !== undefined) data.raidSize = input.raidSize;
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.targetOrder !== undefined) {
        const derived = deriveTargetArrays(input.targetOrder);
        data.targetOrder = input.targetOrder;
        data.targetZoneIds = derived.targetZoneIds;
        data.targetEncounterIds = derived.targetEncounterIds;
      }
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
        select: { raidTeamId: true, seriesId: true },
      });
      if (!event) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, event.raidTeamId, "LEADER");

      await ctx.db.$transaction(async (tx) => {
        const e = await tx.raidEvent.update({
          where: { id: input.eventId },
          data: {
            status: "CANCELLED",
            // Pin a cancelled series occurrence so the materializer never
            // resurrects it and a series edit never re-times it.
            ...(event.seriesId ? { seriesOverride: true } : {}),
            version: { increment: 1 },
          },
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
        select: {
          raidTeamId: true,
          seriesId: true,
          discordChannelId: true,
          discordMessageId: true,
        },
      });
      if (!event) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, event.raidTeamId, "LEADER");
      // A recurring occurrence can't be hard-deleted from here: the materializer
      // would just recreate its (seriesId, occurrenceDate) slot. Cancel it
      // instead (which pins it), or end the whole series.
      if (event.seriesId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This is a recurring occurrence — cancel it instead of deleting, or edit the series.",
        });
      }
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
      // Best-effort: remove the event's Discord board (the relay can't clean up
      // a row that no longer exists).
      await removeEventBoard(event.discordChannelId, event.discordMessageId);
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
      // Role gate needs the team; the event-level guards (past/cancelled) and
      // the membership gate live in the shared applySignupIntent service.
      const event = await ctx.db.raidEvent.findUnique({
        where: { id: input.eventId },
        select: { raidTeamId: true },
      });
      if (!event) throw new TRPCError({ code: "NOT_FOUND" });
      await assertRaidTeamRole(ctx, event.raidTeamId, "MEMBER");

      const characterId = await defaultCharacterId(
        ctx.db,
        ctx.session.user.id,
        event.raidTeamId,
        input.characterId,
      );
      const key = intentKey(ctx.session.user.id, input.eventId, input.clientActionId);

      const result = await applySignupIntent(ctx.db, {
        userId: ctx.session.user.id,
        eventId: input.eventId,
        characterId,
        state: input.state,
        etaMinutes: input.etaMinutes,
        reason: input.reason,
        comment: input.comment,
        source: "WEBSITE",
        idempotencyKey: key,
        updatedByUserId: ctx.session.user.id,
      });
      if (!result.ok) {
        if (result.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND" });
        if (result.reason === "past") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This raid has already finished." });
        }
        if (result.reason === "cancelled") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This raid was cancelled." });
        }
        throw new TRPCError({ code: "BAD_REQUEST", message: "That character is not on this raid team." });
      }
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

  /** Team calendar settings: home timezone + comp template + reminders. LEADER+. */
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
        reminders: reminderConfigSchema.optional(),
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
      if (input.reminders !== undefined) {
        // Normalize through the same parser the sweep uses (dedupe/sort leads).
        data.reminderConfig = parseReminderConfig(input.reminders);
      }
      await ctx.db.raidTeam.update({ where: { id: input.raidTeamId }, data });
      // Audit the privileged config change (incl. who gets emailed + when),
      // matching the audit convention of the other team-settings mutations.
      await audit({
        event: "RAID_TEAM_SETTINGS_UPDATED",
        actorUserId: ctx.session.user.id,
        subjectType: "raidTeam",
        subjectId: input.raidTeamId,
        metadata: { changed: Object.keys(data) },
      });
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
