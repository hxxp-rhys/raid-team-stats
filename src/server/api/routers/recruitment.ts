import { createHash, randomBytes } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { env } from "@/env";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import {
  formStructureSchema,
  themeSchema,
  votingConfigSchema,
  validateSubmission,
  answerToColumns,
  inputFields,
  type FormStructure,
} from "@/lib/recruitment/form-schema";
import {
  assertGuildRole,
  assertRaidTeamRole,
  protectedProcedure,
  publicProcedure,
  router,
  type TrpcContext,
} from "@/server/api/trpc";
import { Prisma } from "@/generated/prisma/client";

/**
 * Recruitment forms router. Officer procedures (protected) manage forms +
 * review submissions; the public `submit`/`getPublic` procedures are the
 * anonymous application surface (the only unauthenticated WRITE path in the
 * app — guarded by honeypot + per-IP rate limit). Officer access = guild
 * OFFICER, or (team-scoped form) team CO_LEADER, or an explicit FormReviewer
 * grant. Voting is OFF by default; per-reviewer notifications are opt-in.
 */

const SLUG_RE = /[^a-z0-9]+/g;
const slugify = (s: string): string =>
  s.toLowerCase().replace(SLUG_RE, "-").replace(/^-+|-+$/g, "").slice(0, 48) ||
  "form";

const ipHash = (ip: string | null): string | null =>
  ip
    ? createHash("sha256").update(`${env.AUTH_SECRET}:${ip}`).digest("hex").slice(0, 32)
    : null;

// ── Officer access ──────────────────────────────────────────────────────────

type FormAccess = {
  form: {
    id: string;
    guildId: string;
    raidTeamId: string | null;
    name: string;
    slug: string;
    status: string;
    votingEnabled: boolean;
    votingConfig: Prisma.JsonValue;
    schema: Prisma.JsonValue;
    schemaVersion: number;
    theme: Prisma.JsonValue;
  };
  isLead: boolean;
};

/** Load a form and assert the caller may review/manage it. Returns lead flag. */
async function requireFormOfficer(
  ctx: TrpcContext,
  formId: string,
): Promise<FormAccess> {
  if (!ctx.session?.user?.id) throw new TRPCError({ code: "UNAUTHORIZED" });
  const form = await ctx.db.recruitmentForm.findUnique({
    where: { id: formId },
    select: {
      id: true,
      guildId: true,
      raidTeamId: true,
      name: true,
      slug: true,
      status: true,
      votingEnabled: true,
      votingConfig: true,
      schema: true,
      schemaVersion: true,
      theme: true,
    },
  });
  if (!form) throw new TRPCError({ code: "NOT_FOUND" });

  // An explicit reviewer grant (possibly a LEAD) — also confers access.
  const grant = await ctx.db.formReviewer.findUnique({
    where: { formId_userId: { formId, userId: ctx.session.user.id } },
    select: { role: true },
  });
  if (grant) return { form, isLead: grant.role === "LEAD" };

  // Otherwise require guild OFFICER (or team CO_LEADER for a team-scoped form).
  // Guild staff are always leads; a team CO_LEADER is a lead for its team form.
  try {
    await assertGuildRole(ctx, form.guildId, "OFFICER");
    return { form, isLead: true };
  } catch {
    /* fall through to team check */
  }
  if (form.raidTeamId) {
    await assertRaidTeamRole(ctx, form.raidTeamId, "CO_LEADER");
    return { form, isLead: true };
  }
  throw new TRPCError({ code: "FORBIDDEN" });
}

const parseStructure = (json: Prisma.JsonValue): FormStructure => {
  const res = formStructureSchema.safeParse(json);
  if (!res.success) {
    // A stored form should always parse; if not, surface a clean error.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "This form's definition is invalid.",
    });
  }
  return res.data;
};

// ── Router ───────────────────────────────────────────────────────────────────

export const recruitmentRouter = router({
  /** Forms for a guild (officer view) with submission counts. */
  listForms: protectedProcedure
    .input(z.object({ guildId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertGuildRole(ctx, input.guildId, "OFFICER");
      const forms = await ctx.db.recruitmentForm.findMany({
        where: { guildId: input.guildId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          raidTeamId: true,
          votingEnabled: true,
          createdAt: true,
          _count: { select: { submissions: { where: { isDraft: false } } } },
        },
      });
      return forms;
    }),

  /** Full form for editing. */
  getForm: protectedProcedure
    .input(z.object({ formId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const { form } = await requireFormOfficer(ctx, input.formId);
      const reviewers = await ctx.db.formReviewer.findMany({
        where: { formId: form.id },
        select: {
          userId: true,
          role: true,
          user: { select: { displayName: true, email: true } },
        },
      });
      return { ...form, reviewers };
    }),

  /** Create a new draft form. */
  createForm: protectedProcedure
    .input(
      z.object({
        guildId: z.string().cuid(),
        raidTeamId: z.string().cuid().nullish(),
        name: z.string().trim().min(1).max(120),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertGuildRole(ctx, input.guildId, "OFFICER");
      if (input.raidTeamId) {
        await assertRaidTeamRole(ctx, input.raidTeamId, "CO_LEADER");
      }
      // A minimal starter structure (one page, a name + a "why join" field).
      const starter: FormStructure = formStructureSchema.parse({
        pages: [
          {
            id: "p1",
            title: "About you",
            fields: [
              { id: "charname", type: "SHORT_TEXT", label: "Character name", required: true },
              { id: "btag", type: "SHORT_TEXT", label: "BattleTag", required: true },
              {
                id: "role",
                type: "SINGLE_SELECT",
                label: "Primary role",
                required: true,
                options: [
                  { id: "t", label: "Tank", value: "tank" },
                  { id: "h", label: "Healer", value: "healer" },
                  { id: "d", label: "DPS", value: "dps" },
                ],
              },
              { id: "logs", type: "URL", label: "Warcraft Logs link" },
              { id: "why", type: "LONG_TEXT", label: "Why do you want to join?", required: true },
            ],
          },
        ],
        settings: { labelFieldId: "charname" },
      });
      const slug = `${slugify(input.name)}-${randomBytes(3).toString("hex")}`;
      const form = await ctx.db.recruitmentForm.create({
        data: {
          guildId: input.guildId,
          raidTeamId: input.raidTeamId ?? null,
          name: input.name,
          slug,
          status: "DRAFT",
          schema: starter as unknown as Prisma.InputJsonValue,
          createdByUserId: ctx.session!.user.id,
        },
        select: { id: true, slug: true },
      });
      return form;
    }),

  /** Update a form's structure / theme / status / voting. Publishing or editing
   *  the structure bumps schemaVersion so prior submissions keep their layout. */
  updateForm: protectedProcedure
    .input(
      z.object({
        formId: z.string().cuid(),
        name: z.string().trim().min(1).max(120).optional(),
        slug: z.string().trim().min(1).max(48).optional(),
        status: z.enum(["DRAFT", "OPEN", "CLOSED", "ARCHIVED"]).optional(),
        schema: formStructureSchema.optional(),
        theme: themeSchema.nullable().optional(),
        votingEnabled: z.boolean().optional(),
        votingConfig: votingConfigSchema.nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { form } = await requireFormOfficer(ctx, input.formId);
      const data: Prisma.RecruitmentFormUpdateInput = {};
      if (input.name != null) data.name = input.name;
      if (input.slug != null) data.slug = slugify(input.slug);
      if (input.status != null) data.status = input.status;
      if (input.schema != null) {
        data.schema = input.schema as unknown as Prisma.InputJsonValue;
        data.schemaVersion = { increment: 1 };
      }
      if (input.theme !== undefined) {
        data.theme =
          input.theme === null
            ? Prisma.JsonNull
            : (input.theme as unknown as Prisma.InputJsonValue);
      }
      if (input.votingEnabled != null) data.votingEnabled = input.votingEnabled;
      if (input.votingConfig !== undefined) {
        data.votingConfig =
          input.votingConfig === null
            ? Prisma.JsonNull
            : (input.votingConfig as unknown as Prisma.InputJsonValue);
      }
      try {
        await ctx.db.recruitmentForm.update({
          where: { id: form.id },
          data,
        });
      } catch (err) {
        // unique (guildId, slug) collision
        throw new TRPCError({
          code: "CONFLICT",
          message: "That link slug is already taken in this guild.",
          cause: err,
        });
      }
      return { ok: true };
    }),

  /** Delete a form (and its submissions, by cascade). */
  removeForm: protectedProcedure
    .input(z.object({ formId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const { form } = await requireFormOfficer(ctx, input.formId);
      await ctx.db.recruitmentForm.delete({ where: { id: form.id } });
      return { ok: true };
    }),

  // ── Reviewers ──
  addReviewer: protectedProcedure
    .input(
      z.object({
        formId: z.string().cuid(),
        userId: z.string().cuid(),
        role: z.enum(["REVIEWER", "LEAD"]).default("REVIEWER"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireFormOfficer(ctx, input.formId);
      await ctx.db.formReviewer.upsert({
        where: { formId_userId: { formId: input.formId, userId: input.userId } },
        create: { formId: input.formId, userId: input.userId, role: input.role },
        update: { role: input.role },
      });
      return { ok: true };
    }),

  removeReviewer: protectedProcedure
    .input(z.object({ formId: z.string().cuid(), userId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireFormOfficer(ctx, input.formId);
      await ctx.db.formReviewer
        .delete({
          where: {
            formId_userId: { formId: input.formId, userId: input.userId },
          },
        })
        .catch(() => {});
      return { ok: true };
    }),

  // ── Submissions inbox ──
  listSubmissions: protectedProcedure
    .input(
      z.object({
        formId: z.string().cuid(),
        status: z
          .enum([
            "NEW",
            "UNDER_REVIEW",
            "TRIAL_OFFERED",
            "ACCEPTED",
            "DECLINED",
            "WITHDRAWN",
          ])
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requireFormOfficer(ctx, input.formId);
      const subs = await ctx.db.formSubmission.findMany({
        where: {
          formId: input.formId,
          isDraft: false,
          ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { submittedAt: "desc" },
        select: {
          id: true,
          status: true,
          applicantLabel: true,
          submittedAt: true,
          _count: { select: { votes: true } },
        },
      });
      return subs;
    }),

  getSubmission: protectedProcedure
    .input(z.object({ submissionId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.session?.user?.id) throw new TRPCError({ code: "UNAUTHORIZED" });
      const sub = await ctx.db.formSubmission.findUnique({
        where: { id: input.submissionId },
        select: {
          id: true,
          formId: true,
          schemaVersion: true,
          status: true,
          applicantLabel: true,
          submittedAt: true,
          answers: {
            select: {
              fieldId: true,
              fieldType: true,
              valueText: true,
              valueNumber: true,
              valueJson: true,
            },
          },
          comments: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              body: true,
              createdAt: true,
              author: { select: { displayName: true } },
            },
          },
          form: {
            select: {
              schema: true,
              votingEnabled: true,
              votingConfig: true,
            },
          },
        },
      });
      if (!sub) throw new TRPCError({ code: "NOT_FOUND" });
      await requireFormOfficer(ctx, sub.formId);

      // Field labels from the form structure (for rendering the answers).
      const structure = parseStructure(sub.form.schema);
      const labels: Record<string, string> = {};
      for (const f of inputFields(structure)) labels[f.id] = f.label;

      // Voting (hide-until-voted): only when voting is enabled.
      const votingCfg = votingConfigSchema.safeParse(sub.form.votingConfig);
      const hideUntilVoted =
        sub.form.votingEnabled && (votingCfg.success ? votingCfg.data.hideUntilVoted : true);
      const allVotes = sub.form.votingEnabled
        ? await ctx.db.submissionVote.findMany({
            where: { submissionId: sub.id },
            select: {
              reviewerUserId: true,
              value: true,
              rationale: true,
              updatedAt: true,
              reviewer: { select: { displayName: true } },
            },
          })
        : [];
      const myVote = allVotes.find((v) => v.reviewerUserId === ctx.session!.user.id) ?? null;
      const revealed = !hideUntilVoted || myVote != null;

      return {
        id: sub.id,
        status: sub.status,
        applicantLabel: sub.applicantLabel,
        submittedAt: sub.submittedAt,
        answers: sub.answers.map((a) => ({ ...a, label: labels[a.fieldId] ?? a.fieldId })),
        comments: sub.comments,
        voting: {
          enabled: sub.form.votingEnabled,
          revealed,
          voterCount: allVotes.length,
          myVote: myVote
            ? { value: myVote.value, rationale: myVote.rationale }
            : null,
          // Others' votes are redacted until the viewer has cast their own.
          votes: revealed
            ? allVotes.map((v) => ({
                reviewer: v.reviewer.displayName ?? "Reviewer",
                value: v.value,
                rationale: v.rationale,
              }))
            : [],
        },
      };
    }),

  setSubmissionStatus: protectedProcedure
    .input(
      z.object({
        submissionId: z.string().cuid(),
        status: z.enum([
          "NEW",
          "UNDER_REVIEW",
          "TRIAL_OFFERED",
          "ACCEPTED",
          "DECLINED",
          "WITHDRAWN",
        ]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sub = await ctx.db.formSubmission.findUnique({
        where: { id: input.submissionId },
        select: { formId: true },
      });
      if (!sub) throw new TRPCError({ code: "NOT_FOUND" });
      await requireFormOfficer(ctx, sub.formId);
      await ctx.db.formSubmission.update({
        where: { id: input.submissionId },
        data: { status: input.status },
      });
      await ctx.db.recruitmentNotificationOutbox
        .create({
          data: { submissionId: input.submissionId, kind: "STATUS_CHANGE" },
        })
        .catch(() => {});
      return { ok: true };
    }),

  vote: protectedProcedure
    .input(
      z.object({
        submissionId: z.string().cuid(),
        value: z.enum(["STRONG_NO", "NO", "YES", "STRONG_YES", "ABSTAIN"]),
        rationale: z.string().trim().min(1).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sub = await ctx.db.formSubmission.findUnique({
        where: { id: input.submissionId },
        select: { formId: true, form: { select: { votingEnabled: true } } },
      });
      if (!sub) throw new TRPCError({ code: "NOT_FOUND" });
      if (!sub.form.votingEnabled) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Voting is not enabled for this form.",
        });
      }
      await requireFormOfficer(ctx, sub.formId);
      await ctx.db.submissionVote.upsert({
        where: {
          submissionId_reviewerUserId: {
            submissionId: input.submissionId,
            reviewerUserId: ctx.session!.user.id,
          },
        },
        create: {
          submissionId: input.submissionId,
          reviewerUserId: ctx.session!.user.id,
          value: input.value,
          rationale: input.rationale,
          source: "WEB",
        },
        update: {
          value: input.value,
          rationale: input.rationale,
          version: { increment: 1 },
        },
      });
      return { ok: true };
    }),

  addComment: protectedProcedure
    .input(
      z.object({
        submissionId: z.string().cuid(),
        body: z.string().trim().min(1).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sub = await ctx.db.formSubmission.findUnique({
        where: { id: input.submissionId },
        select: { formId: true },
      });
      if (!sub) throw new TRPCError({ code: "NOT_FOUND" });
      await requireFormOfficer(ctx, sub.formId);
      await ctx.db.submissionComment.create({
        data: {
          submissionId: input.submissionId,
          authorUserId: ctx.session!.user.id,
          body: input.body,
        },
      });
      return { ok: true };
    }),

  // ── Notification preferences (per-reviewer opt-in) ──
  myNotificationPrefs: protectedProcedure
    .input(z.object({ formId: z.string().cuid().nullish() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.session?.user?.id) throw new TRPCError({ code: "UNAUTHORIZED" });
      return ctx.db.recruitmentNotificationPref.findMany({
        where: { userId: ctx.session.user.id, formId: input.formId ?? null },
        select: { id: true, channel: true, onNew: true, onStatusChange: true, onQuorum: true },
      });
    }),

  setNotificationPref: protectedProcedure
    .input(
      z.object({
        formId: z.string().cuid().nullish(),
        channel: z.enum(["EMAIL", "DISCORD_DM"]),
        onNew: z.boolean().default(true),
        onStatusChange: z.boolean().default(false),
        onQuorum: z.boolean().default(false),
        // false = opt OUT (delete the pref row)
        enabled: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.session?.user?.id) throw new TRPCError({ code: "UNAUTHORIZED" });
      // A reviewer can only set prefs for a form they can review.
      if (input.formId) await requireFormOfficer(ctx, input.formId);
      const userId = ctx.session.user.id;
      const formId = input.formId ?? null;

      if (!input.enabled) {
        await ctx.db.recruitmentNotificationPref.deleteMany({
          where: { userId, formId, channel: input.channel },
        });
        return { ok: true, enabled: false };
      }
      // The unique key (userId, formId, channel) has a NULLABLE formId, so a
      // compound-unique upsert can't express it — find-then-write manually.
      const existing = await ctx.db.recruitmentNotificationPref.findFirst({
        where: { userId, formId, channel: input.channel },
        select: { id: true },
      });
      const data = {
        onNew: input.onNew,
        onStatusChange: input.onStatusChange,
        onQuorum: input.onQuorum,
      };
      if (existing) {
        await ctx.db.recruitmentNotificationPref.update({
          where: { id: existing.id },
          data,
        });
      } else {
        await ctx.db.recruitmentNotificationPref.create({
          data: { userId, formId, channel: input.channel, ...data },
        });
      }
      return { ok: true, enabled: true };
    }),

  // ── Public surface (anonymous) ──
  /** Resolve a published (OPEN) form by slug for the public renderer. */
  getPublic: publicProcedure
    .input(z.object({ guildId: z.string().cuid(), slug: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const form = await ctx.db.recruitmentForm.findUnique({
        where: { guildId_slug: { guildId: input.guildId, slug: input.slug } },
        select: {
          id: true,
          name: true,
          status: true,
          schema: true,
          theme: true,
          schemaVersion: true,
        },
      });
      if (!form || form.status !== "OPEN") {
        // Don't distinguish "missing" from "closed" to the public.
        throw new TRPCError({ code: "NOT_FOUND", message: "This form isn't open." });
      }
      return {
        id: form.id,
        name: form.name,
        schema: form.schema,
        theme: form.theme,
        schemaVersion: form.schemaVersion,
      };
    }),

  /** Anonymous application submission — the only unauthenticated write path. */
  submit: publicProcedure
    .input(
      z.object({
        formId: z.string().cuid(),
        answers: z.record(z.string(), z.unknown()),
        // honeypot: a hidden field bots fill — if present, silently drop.
        hp: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const form = await ctx.db.recruitmentForm.findUnique({
        where: { id: input.formId },
        select: {
          id: true,
          status: true,
          schema: true,
          schemaVersion: true,
          _count: { select: { submissions: { where: { isDraft: false } } } },
        },
      });
      if (!form || form.status !== "OPEN") {
        throw new TRPCError({ code: "NOT_FOUND", message: "This form isn't open." });
      }

      // Honeypot: pretend success without writing (don't tip off the bot).
      if (input.hp && input.hp.trim() !== "") {
        return { ok: true as const, submissionId: null, redirectUrl: null };
      }

      const structure = parseStructure(form.schema);

      // Close-on-date + submission cap.
      const closeAt = structure.settings.closeAt
        ? new Date(structure.settings.closeAt)
        : null;
      if (closeAt && closeAt.getTime() < Date.now()) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This form has closed." });
      }
      if (
        structure.settings.maxSubmissions != null &&
        form._count.submissions >= structure.settings.maxSubmissions
      ) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This form is no longer accepting submissions." });
      }

      // Per-IP rate limit (5 / hour / form) when enabled.
      if (structure.antiSpam.rateLimit && ctx.ip) {
        const k = `recruit:rl:${form.id}:${ipHash(ctx.ip)}`;
        try {
          const n = await redis.incr(k);
          if (n === 1) await redis.expire(k, 3600);
          if (n > 5) {
            throw new TRPCError({
              code: "TOO_MANY_REQUESTS",
              message: "Too many submissions — try again later.",
            });
          }
        } catch (err) {
          if (err instanceof TRPCError) throw err;
          logger.warn({ err }, "recruit: rate-limit check failed (allowing)");
        }
      }

      const result = validateSubmission(structure, input.answers);
      if (!result.ok) {
        return { ok: false as const, errors: result.errors };
      }

      // Applicant label from the designated field.
      const labelFieldId = structure.settings.labelFieldId;
      const labelVal = labelFieldId ? result.answers[labelFieldId] : undefined;
      const applicantLabel =
        labelVal != null ? String(labelVal).slice(0, 120) : null;

      const fieldTypeById = new Map(
        inputFields(structure).map((f) => [f.id, f.type]),
      );
      const answerRows = Object.entries(result.answers).map(([fieldId, value]) => {
        const ft = fieldTypeById.get(fieldId)!;
        const cols = answerToColumns(ft, value);
        return {
          fieldId,
          fieldType: ft,
          valueText: cols.valueText,
          valueNumber: cols.valueNumber,
          valueJson:
            cols.valueJson == null
              ? Prisma.JsonNull
              : (cols.valueJson as Prisma.InputJsonValue),
        };
      });

      const submission = await ctx.db.formSubmission.create({
        data: {
          formId: form.id,
          schemaVersion: form.schemaVersion,
          status: "NEW",
          isDraft: false,
          applicantUserId: ctx.session?.user?.id ?? null,
          applicantLabel,
          answersJson: result.answers as unknown as Prisma.InputJsonValue,
          ipHash: ipHash(ctx.ip),
          submittedAt: new Date(),
          answers: { create: answerRows },
        },
        select: { id: true },
      });

      // Enqueue the new-submission notification (drained by the worker).
      await ctx.db.recruitmentNotificationOutbox
        .create({
          data: { submissionId: submission.id, kind: "NEW_SUBMISSION" },
        })
        .catch((err) =>
          logger.warn({ err }, "recruit: outbox enqueue failed (submission saved)"),
        );

      return {
        ok: true as const,
        submissionId: submission.id,
        redirectUrl: structure.settings.redirectUrl ?? null,
      };
    }),
});
