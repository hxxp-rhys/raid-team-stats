import { z } from "zod";

/**
 * Recruitment form schema — the SINGLE SOURCE OF TRUTH for a form's structure,
 * branding, and validation. A form's `schema` JSON column is validated against
 * `formStructureSchema`; the public renderer AND the server-side submission
 * validator are both derived from the same definition via `buildZodForField` /
 * `validateSubmission`, so "client says OK, server rejects" can't happen.
 *
 * Pure (no server imports) so vitest pins it. v1 scope per the form-builder
 * research: 12 input field types + content blocks, per-field validation incl.
 * regex with presets, minimal show/hide conditional logic, both layout modes
 * via pages + autoAdvance. File upload, page-branching, calculations are later.
 */

// ── Field types ───────────────────────────────────────────────────────────

export const FIELD_TYPES = [
  // input fields (collect an answer)
  "SHORT_TEXT",
  "LONG_TEXT",
  "EMAIL",
  "NUMBER",
  "URL",
  "SINGLE_SELECT",
  "DROPDOWN",
  "MULTI_SELECT",
  "YES_NO",
  "RATING",
  "LINEAR_SCALE",
  "DATE",
  // content blocks (no answer)
  "HEADING",
  "DIVIDER",
  "RICH_TEXT",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Field types that collect an answer (everything except content blocks). */
export const INPUT_FIELD_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "SHORT_TEXT",
  "LONG_TEXT",
  "EMAIL",
  "NUMBER",
  "URL",
  "SINGLE_SELECT",
  "DROPDOWN",
  "MULTI_SELECT",
  "YES_NO",
  "RATING",
  "LINEAR_SCALE",
  "DATE",
]);

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Must be a #rrggbb hex color");

const optionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  value: z.string().min(1).max(200),
});

const fieldValidationSchema = z
  .object({
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    integerOnly: z.boolean().optional(),
    minSelections: z.number().int().nonnegative().optional(),
    maxSelections: z.number().int().positive().optional(),
    pattern: z.string().max(300).optional(),
    patternMessage: z.string().max(200).optional(),
  })
  .strict();
export type FieldValidation = z.infer<typeof fieldValidationSchema>;

const visibleWhenSchema = z
  .object({
    fieldId: z.string().min(1).max(64),
    operator: z.enum(["equals", "notEquals", "contains", "isFilled", "isEmpty"]),
    value: z.string().max(200).optional(),
  })
  .strict();

export const fieldSchema = z
  .object({
    id: z.string().min(1).max(64),
    type: z.enum(FIELD_TYPES),
    label: z.string().min(1).max(300),
    help: z.string().max(500).optional(),
    placeholder: z.string().max(200).optional(),
    required: z.boolean().optional(),
    // choice fields
    options: z.array(optionSchema).max(80).optional(),
    display: z
      .enum(["radio", "dropdown", "buttons", "checkboxes", "tags"])
      .optional(),
    allowOther: z.boolean().optional(),
    // rating / scale
    scaleMin: z.number().int().min(0).max(10).optional(),
    scaleMax: z.number().int().min(1).max(10).optional(),
    scaleMinLabel: z.string().max(60).optional(),
    scaleMaxLabel: z.string().max(60).optional(),
    // content blocks (HEADING / RICH_TEXT)
    content: z.string().max(4000).optional(),
    validation: fieldValidationSchema.optional(),
    visibleWhen: visibleWhenSchema.optional(),
  })
  .strict();
export type Field = z.infer<typeof fieldSchema>;

const pageSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(200).optional(),
  fields: z.array(fieldSchema).max(80),
});
export type FormPage = z.infer<typeof pageSchema>;

const layoutSchema = z
  .object({
    mode: z.enum(["paged", "single"]).default("paged"),
    autoAdvance: z.boolean().default(false),
    showProgress: z.boolean().default(true),
  })
  .strict();

const antiSpamSchema = z
  .object({
    honeypot: z.boolean().default(true),
    captcha: z.boolean().default(false),
    rateLimit: z.boolean().default(true),
  })
  .strict();

const settingsSchema = z
  .object({
    closeAt: z.string().datetime().nullable().optional(),
    maxSubmissions: z.number().int().positive().nullable().optional(),
    // field id whose answer labels a submission in the inbox + notifications
    labelFieldId: z.string().max(64).optional(),
    // optional post-submit redirect (e.g. the guild Discord invite)
    redirectUrl: z.string().url().nullable().optional(),
  })
  .strict();

export const formStructureSchema = z
  .object({
    version: z.literal(1).default(1),
    pages: z.array(pageSchema).min(1).max(20),
    layout: layoutSchema.default({
      mode: "paged",
      autoAdvance: false,
      showProgress: true,
    }),
    antiSpam: antiSpamSchema.default({
      honeypot: true,
      captcha: false,
      rateLimit: true,
    }),
    settings: settingsSchema.default({}),
  })
  .strict();
export type FormStructure = z.infer<typeof formStructureSchema>;

// ── Theme ─────────────────────────────────────────────────────────────────

export const themeSchema = z
  .object({
    logoUrl: z.string().url().nullable().optional(),
    coverImageUrl: z.string().url().nullable().optional(),
    faviconUrl: z.string().url().nullable().optional(),
    background: z
      .object({
        kind: z.enum(["color", "gradient", "image"]).default("color"),
        color: hexColor.optional(),
        gradient: z
          .object({
            from: hexColor,
            to: hexColor,
            angle: z.number().min(0).max(360).default(135),
          })
          .optional(),
        imageUrl: z.string().url().optional(),
        overlayOpacity: z.number().min(0).max(1).optional(),
      })
      .optional(),
    colors: z
      .object({
        primary: hexColor.optional(),
        questionText: hexColor.optional(),
        answerText: hexColor.optional(),
        button: hexColor.optional(),
        buttonText: hexColor.optional(),
      })
      .optional(),
    font: z
      .object({
        family: z.string().max(60).optional(),
        scale: z.number().min(0.8).max(1.5).optional(),
      })
      .optional(),
    buttonStyle: z
      .object({
        radius: z.enum(["none", "sm", "md", "lg", "full"]).optional(),
        fill: z.enum(["solid", "outline"]).optional(),
      })
      .optional(),
    welcome: z
      .object({
        title: z.string().max(200).optional(),
        body: z.string().max(2000).optional(),
        buttonText: z.string().max(60).optional(),
      })
      .optional(),
    thankYou: z
      .object({
        title: z.string().max(200).optional(),
        body: z.string().max(2000).optional(),
      })
      .optional(),
  })
  .strict();
export type FormTheme = z.infer<typeof themeSchema>;

// ── Voting config ─────────────────────────────────────────────────────────

export const votingConfigSchema = z
  .object({
    quorum: z.number().int().min(1).max(50).default(2),
    threshold: z.enum(["majority", "supermajority"]).default("majority"),
    hideUntilVoted: z.boolean().default(true),
    allowAbstain: z.boolean().default(true),
  })
  .strict();
export type VotingConfig = z.infer<typeof votingConfigSchema>;

// ── Preset regex patterns (offered in the builder so officers never hand-write) ──

export const PRESET_PATTERNS: Record<
  string,
  { label: string; pattern: string; message: string }
> = {
  battletag: {
    label: "BattleTag",
    pattern: "^.{2,12}#\\d{4,5}$",
    message: "Looks like Name#1234",
  },
  discord: {
    label: "Discord handle",
    pattern: "^(?!.*\\.\\.)[a-z0-9._]{2,32}$",
    message: "Lowercase letters, numbers, _ and . (2–32 chars)",
  },
  wclReport: {
    label: "Warcraft Logs report",
    pattern: "^https?://(www\\.)?warcraftlogs\\.com/reports/[A-Za-z0-9]+",
    message: "A warcraftlogs.com/reports/… link",
  },
  armory: {
    label: "Armory link",
    pattern: "^https?://worldofwarcraft\\.(com|blizzard\\.com)/.*character",
    message: "A WoW Armory character link",
  },
};

// ── Conditional visibility ──────────────────────────────────────────────────

const isEmptyValue = (a: unknown): boolean =>
  a == null || a === "" || (Array.isArray(a) && a.length === 0);

/** Evaluate a field's `visibleWhen` against the current answers (default: shown). */
export function evaluateVisible(
  field: Field,
  answers: Record<string, unknown>,
): boolean {
  const cond = field.visibleWhen;
  if (!cond) return true;
  const a = answers[cond.fieldId];
  switch (cond.operator) {
    case "isFilled":
      return !isEmptyValue(a);
    case "isEmpty":
      return isEmptyValue(a);
    case "equals":
      return String(a ?? "") === (cond.value ?? "");
    case "notEquals":
      return String(a ?? "") !== (cond.value ?? "");
    case "contains":
      return Array.isArray(a)
        ? a.map(String).includes(cond.value ?? "")
        : String(a ?? "").includes(cond.value ?? "");
    default:
      return true;
  }
}

// ── Per-field answer validator (the render/validate single source of truth) ──

/** Build a Zod schema for ONE field's answer value (presence handled by caller). */
export function buildZodForField(field: Field): z.ZodTypeAny {
  const v = field.validation ?? {};
  switch (field.type) {
    case "SHORT_TEXT":
    case "LONG_TEXT": {
      let s = z.string();
      if (v.minLength) s = s.min(v.minLength);
      if (v.maxLength) s = s.max(v.maxLength);
      if (v.pattern) {
        try {
          const re = new RegExp(v.pattern);
          s = s.regex(re, v.patternMessage ?? "Invalid format.");
        } catch {
          /* a malformed pattern is ignored rather than rejecting every answer */
        }
      }
      return s;
    }
    case "EMAIL":
      return z.string().email("Enter a valid email.");
    case "URL":
      return z.string().url("Enter a valid URL.");
    case "NUMBER": {
      let n = z.number();
      if (v.integerOnly) n = n.int();
      if (v.min != null) n = n.min(v.min);
      if (v.max != null) n = n.max(v.max);
      return n;
    }
    case "SINGLE_SELECT":
    case "DROPDOWN": {
      const vals = (field.options ?? []).map((o) => o.value);
      if (field.allowOther || vals.length === 0) return z.string().min(1);
      return z.enum([vals[0]!, ...vals.slice(1)] as [string, ...string[]]);
    }
    case "MULTI_SELECT": {
      let arr = z.array(z.string());
      if (v.minSelections) arr = arr.min(v.minSelections);
      if (v.maxSelections) arr = arr.max(v.maxSelections);
      return arr;
    }
    case "YES_NO":
      return z.boolean();
    case "RATING":
    case "LINEAR_SCALE": {
      const mn = field.scaleMin ?? 1;
      const mx = field.scaleMax ?? 5;
      return z.number().int().min(mn).max(mx);
    }
    case "DATE":
      return z.string().min(1);
    default:
      // content blocks collect no answer
      return z.any();
  }
}

export type SubmissionValidationResult =
  | { ok: true; answers: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> };

/**
 * Validate a raw submission against the form structure. Only VISIBLE input
 * fields are validated (a hidden required field must NOT block submission —
 * the Paperform gotcha). Returns the cleaned answers or per-field errors.
 */
export function validateSubmission(
  structure: FormStructure,
  rawAnswers: Record<string, unknown>,
): SubmissionValidationResult {
  const fields = structure.pages
    .flatMap((p) => p.fields)
    .filter((f) => INPUT_FIELD_TYPES.has(f.type));
  const errors: Record<string, string> = {};
  const clean: Record<string, unknown> = {};

  for (const f of fields) {
    if (!evaluateVisible(f, rawAnswers)) continue;
    const raw = rawAnswers[f.id];
    if (isEmptyValue(raw)) {
      if (f.required) errors[f.id] = "This field is required.";
      continue;
    }
    const res = buildZodForField(f).safeParse(raw);
    if (!res.success) {
      errors[f.id] = res.error.issues[0]?.message ?? "Invalid value.";
    } else {
      clean[f.id] = res.data;
    }
  }

  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, answers: clean };
}

/** Flatten all input fields of a structure (render/inbox/export helper). */
export function inputFields(structure: FormStructure): Field[] {
  return structure.pages
    .flatMap((p) => p.fields)
    .filter((f) => INPUT_FIELD_TYPES.has(f.type));
}

/** Coerce a validated answer into the FormAnswer storage columns. */
export function answerToColumns(
  fieldType: FieldType,
  value: unknown,
): { valueText: string | null; valueNumber: number | null; valueJson: unknown } {
  switch (fieldType) {
    case "NUMBER":
    case "RATING":
    case "LINEAR_SCALE":
      return {
        valueNumber: typeof value === "number" ? value : null,
        valueText: value != null ? String(value) : null,
        valueJson: null,
      };
    case "MULTI_SELECT":
      return {
        valueJson: Array.isArray(value) ? value : null,
        valueText: Array.isArray(value) ? value.join(", ") : null,
        valueNumber: null,
      };
    case "YES_NO":
      return {
        valueText: value ? "Yes" : "No",
        valueJson: Boolean(value),
        valueNumber: null,
      };
    default:
      return {
        valueText: value != null ? String(value) : null,
        valueNumber: null,
        valueJson: null,
      };
  }
}
