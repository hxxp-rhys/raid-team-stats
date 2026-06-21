"use client";

import { useMemo, useState } from "react";

import { api } from "@/lib/trpc-client";
import {
  evaluateVisible,
  formStructureSchema,
  themeSchema,
  validateSubmission,
  type Field,
  type FormStructure,
  type FormTheme,
} from "@/lib/recruitment/form-schema";

/**
 * Public recruitment form — the anonymous applicant surface. Renders the form
 * from its JSON schema, applies the guild's theme (background / colors / logo /
 * cover / font), validates client-side (the server re-validates), and submits
 * via the public `recruitment.submit` procedure. A honeypot field (hidden) is
 * the first anti-spam layer.
 */

type Answers = Record<string, unknown>;

/** Compute the form background CSS from its theme (color / image+overlay /
 *  gradient). Shared by the live applicant form and the in-builder preview. */
function bgFromTheme(theme: FormTheme): string | undefined {
  const bgOverlay = theme.background?.overlayOpacity ?? 0.45;
  if (theme.background?.kind === "image" && theme.background.imageUrl) {
    // dark overlay layered over the cover image so form text stays legible
    return `linear-gradient(rgba(0,0,0,${bgOverlay}), rgba(0,0,0,${bgOverlay})), url("${theme.background.imageUrl}") center/cover no-repeat`;
  }
  if (theme.background?.kind === "color") return theme.background.color;
  if (theme.background?.kind === "gradient" && theme.background.gradient) {
    return `linear-gradient(${theme.background.gradient.angle}deg, ${theme.background.gradient.from}, ${theme.background.gradient.to})`;
  }
  return undefined;
}

export function PublicForm({ guildId, slug }: { guildId: string; slug: string }) {
  const q = api.recruitment.getPublic.useQuery({ guildId, slug });
  const submit = api.recruitment.submit.useMutation();

  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hp, setHp] = useState(""); // honeypot
  const [done, setDone] = useState(false);

  const structure: FormStructure | null = useMemo(() => {
    if (!q.data) return null;
    const r = formStructureSchema.safeParse(q.data.schema);
    return r.success ? r.data : null;
  }, [q.data]);

  const theme: FormTheme = useMemo(() => {
    const r = themeSchema.safeParse(q.data?.theme ?? {});
    return r.success ? r.data : {};
  }, [q.data]);

  if (q.isPending) {
    return <Centered>Loading…</Centered>;
  }
  if (q.error || !structure) {
    return (
      <Centered>
        <h1 className="text-lg font-semibold">This form isn&apos;t available</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          The link may be closed or no longer exist.
        </p>
      </Centered>
    );
  }

  const bg = bgFromTheme(theme);
  const primary = theme.colors?.primary ?? "#c8a04f";
  const fontFamily = theme.font?.family;

  if (done) {
    return (
      <Shell bg={bg} fontFamily={fontFamily}>
        <Card primary={primary}>
          {theme.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={theme.logoUrl} alt="" className="mx-auto mb-4 h-16 w-auto" />
          )}
          <h1 className="text-center text-xl font-semibold">
            {theme.thankYou?.title ?? "Application received"}
          </h1>
          <p className="text-muted-foreground mt-2 text-center text-sm">
            {theme.thankYou?.body ??
              "Thanks for applying — an officer will review your application."}
          </p>
        </Card>
      </Shell>
    );
  }

  const fields = structure.pages.flatMap((p) => p.fields);

  const setAnswer = (id: string, v: unknown) =>
    setAnswers((a) => ({ ...a, [id]: v }));

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const res = validateSubmission(structure, answers);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors({});
    submit.mutate(
      { formId: q.data!.id, answers, hp: hp || undefined },
      {
        onSuccess: (r) => {
          if (!r.ok) {
            setErrors(r.errors);
            return;
          }
          if (r.redirectUrl) {
            window.location.href = r.redirectUrl;
            return;
          }
          setDone(true);
        },
      },
    );
  };

  return (
    <Shell bg={bg} fontFamily={fontFamily}>
      {theme.coverImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={theme.coverImageUrl}
          alt=""
          className="mb-4 max-h-48 w-full max-w-2xl rounded-xl object-cover"
        />
      )}
      <Card primary={primary}>
        {theme.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={theme.logoUrl} alt="" className="mb-4 h-14 w-auto" />
        )}
        <h1 className="text-xl font-semibold" style={{ color: theme.colors?.questionText }}>
          {theme.welcome?.title ?? q.data!.name}
        </h1>
        {theme.welcome?.body && (
          <p className="text-muted-foreground mt-1 text-sm">{theme.welcome.body}</p>
        )}

        <form onSubmit={onSubmit} className="mt-5 space-y-5">
          {fields.map((f) =>
            evaluateVisible(f, answers) ? (
              <FieldInput
                key={f.id}
                field={f}
                value={answers[f.id]}
                onChange={(v) => setAnswer(f.id, v)}
                error={errors[f.id]}
                primary={primary}
              />
            ) : null,
          )}

          {/* Honeypot — visually hidden, bots fill it. */}
          <input
            type="text"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            value={hp}
            onChange={(e) => setHp(e.target.value)}
            style={{ position: "absolute", left: "-9999px", width: 1, height: 1 }}
          />

          {submit.error && (
            <p className="text-destructive text-sm" role="alert">
              {submit.error.message}
            </p>
          )}
          <button
            type="submit"
            disabled={submit.isPending}
            className="w-full rounded-md px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
            style={{
              backgroundColor: theme.colors?.button ?? primary,
              color: theme.colors?.buttonText ?? "#0b0e14",
            }}
          >
            {submit.isPending
              ? "Submitting…"
              : (theme.welcome?.buttonText ?? "Submit application")}
          </button>
        </form>
      </Card>
    </Shell>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  error,
  primary,
}: {
  field: Field;
  value: unknown;
  onChange: (v: unknown) => void;
  error?: string;
  primary: string;
}) {
  // Content blocks
  if (field.type === "HEADING")
    return <h2 className="mt-2 text-base font-semibold">{field.label}</h2>;
  if (field.type === "DIVIDER")
    return <hr className="border-border" />;
  if (field.type === "RICH_TEXT")
    return (
      <p className="text-muted-foreground text-sm whitespace-pre-wrap">
        {field.content ?? field.label}
      </p>
    );

  const labelEl = (
    <label className="mb-1 block text-sm font-medium" htmlFor={field.id}>
      {field.label}
      {field.required && <span className="text-destructive"> *</span>}
    </label>
  );
  const help = field.help && (
    <p className="text-muted-foreground mb-1 text-xs">{field.help}</p>
  );
  const errEl = error && (
    <p className="text-destructive mt-1 text-xs" role="alert">
      {error}
    </p>
  );
  const inputCls =
    "border-border bg-background w-full rounded-md border px-3 py-2 text-sm";
  const str = typeof value === "string" ? value : "";

  switch (field.type) {
    case "LONG_TEXT":
      return (
        <div>
          {labelEl}
          {help}
          <textarea
            id={field.id}
            className={inputCls}
            rows={4}
            value={str}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
          {errEl}
        </div>
      );
    case "SHORT_TEXT":
    case "EMAIL":
    case "URL":
    case "DATE":
      return (
        <div>
          {labelEl}
          {help}
          <input
            id={field.id}
            type={
              field.type === "EMAIL"
                ? "email"
                : field.type === "URL"
                  ? "url"
                  : field.type === "DATE"
                    ? "date"
                    : "text"
            }
            className={inputCls}
            value={str}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
          {errEl}
        </div>
      );
    case "NUMBER":
      return (
        <div>
          {labelEl}
          {help}
          <input
            id={field.id}
            type="number"
            className={inputCls}
            value={typeof value === "number" ? value : ""}
            onChange={(e) =>
              onChange(e.target.value === "" ? undefined : Number(e.target.value))
            }
          />
          {errEl}
        </div>
      );
    case "YES_NO":
      return (
        <div>
          {labelEl}
          {help}
          <div className="flex gap-2">
            {[true, false].map((b) => (
              <button
                key={String(b)}
                type="button"
                onClick={() => onChange(b)}
                className="rounded-md border px-3 py-1.5 text-sm"
                style={
                  value === b
                    ? { backgroundColor: primary, color: "#0b0e14", borderColor: primary }
                    : undefined
                }
              >
                {b ? "Yes" : "No"}
              </button>
            ))}
          </div>
          {errEl}
        </div>
      );
    case "SINGLE_SELECT":
    case "DROPDOWN": {
      const opts = field.options ?? [];
      if (field.type === "DROPDOWN" || opts.length > 5) {
        return (
          <div>
            {labelEl}
            {help}
            <select
              id={field.id}
              className={inputCls}
              value={str}
              onChange={(e) => onChange(e.target.value)}
            >
              <option value="">Select…</option>
              {opts.map((o) => (
                <option key={o.id} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {errEl}
          </div>
        );
      }
      return (
        <div>
          {labelEl}
          {help}
          <div className="flex flex-wrap gap-2">
            {opts.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => onChange(o.value)}
                className="rounded-md border px-3 py-1.5 text-sm"
                style={
                  value === o.value
                    ? { backgroundColor: primary, color: "#0b0e14", borderColor: primary }
                    : undefined
                }
              >
                {o.label}
              </button>
            ))}
          </div>
          {errEl}
        </div>
      );
    }
    case "MULTI_SELECT": {
      const opts = field.options ?? [];
      const arr = Array.isArray(value) ? (value as string[]) : [];
      const toggle = (v: string) =>
        onChange(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
      return (
        <div>
          {labelEl}
          {help}
          <div className="flex flex-wrap gap-2">
            {opts.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => toggle(o.value)}
                className="rounded-md border px-3 py-1.5 text-sm"
                style={
                  arr.includes(o.value)
                    ? { backgroundColor: primary, color: "#0b0e14", borderColor: primary }
                    : undefined
                }
              >
                {o.label}
              </button>
            ))}
          </div>
          {errEl}
        </div>
      );
    }
    case "RATING":
    case "LINEAR_SCALE": {
      const mn = field.scaleMin ?? 1;
      const mx = field.scaleMax ?? 5;
      const nums = Array.from({ length: mx - mn + 1 }, (_, i) => mn + i);
      return (
        <div>
          {labelEl}
          {help}
          <div className="flex flex-wrap gap-1.5">
            {nums.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onChange(n)}
                className="h-9 w-9 rounded-md border text-sm"
                style={
                  value === n
                    ? { backgroundColor: primary, color: "#0b0e14", borderColor: primary }
                    : undefined
                }
              >
                {n}
              </button>
            ))}
          </div>
          {errEl}
        </div>
      );
    }
    default:
      return null;
  }
}

function Shell({
  children,
  bg,
  fontFamily,
}: {
  children: React.ReactNode;
  bg?: string;
  fontFamily?: string;
}) {
  return (
    <main
      className="flex min-h-screen flex-col items-center px-4 py-10"
      style={{ background: bg, fontFamily }}
    >
      {children}
    </main>
  );
}

function Card({
  children,
  primary,
}: {
  children: React.ReactNode;
  primary: string;
}) {
  return (
    <div
      className="bg-card w-full max-w-2xl rounded-xl border p-6 shadow-sm"
      style={{ borderTopColor: primary, borderTopWidth: 3 }}
    >
      {children}
    </div>
  );
}

/**
 * In-builder PREVIEW of a form, rendered from the CURRENT (possibly unsaved)
 * structure + theme — NOT fetched from the server. Reuses the exact applicant
 * Card + FieldInput so the preview matches the live form. Fields are
 * interactive (so the lead can try them) but submit is inert (visual only).
 * Renders a CONTAINED shell (no min-h-screen) so it fits inside a modal.
 */
export function FormPreview({
  structure,
  theme: rawTheme,
  name,
}: {
  structure: FormStructure;
  theme: unknown;
  name: string;
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const setAnswer = (id: string, v: unknown) =>
    setAnswers((a) => ({ ...a, [id]: v }));
  const theme: FormTheme = useMemo(() => {
    const r = themeSchema.safeParse(rawTheme ?? {});
    return r.success ? r.data : {};
  }, [rawTheme]);

  const bg = bgFromTheme(theme);
  const primary = theme.colors?.primary ?? "#c8a04f";
  const fontFamily = theme.font?.family;
  const fields = structure.pages.flatMap((p) => p.fields);

  return (
    <div
      className="flex flex-col items-center rounded-md px-4 py-6"
      style={{ background: bg, fontFamily }}
    >
      {theme.coverImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={theme.coverImageUrl}
          alt=""
          className="mb-4 max-h-40 w-full max-w-2xl rounded-xl object-cover"
        />
      )}
      <Card primary={primary}>
        {theme.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={theme.logoUrl} alt="" className="mb-4 h-14 w-auto" />
        )}
        <h1 className="text-xl font-semibold" style={{ color: theme.colors?.questionText }}>
          {theme.welcome?.title ?? name}
        </h1>
        {theme.welcome?.body && (
          <p className="text-muted-foreground mt-1 text-sm">{theme.welcome.body}</p>
        )}
        <div className="mt-5 space-y-5">
          {fields.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No questions yet — add fields to see them here.
            </p>
          ) : (
            fields.map((f) =>
              evaluateVisible(f, answers) ? (
                <FieldInput
                  key={f.id}
                  field={f}
                  value={answers[f.id]}
                  onChange={(v) => setAnswer(f.id, v)}
                  primary={primary}
                />
              ) : null,
            )
          )}
          <button
            type="button"
            disabled
            className="w-full cursor-default rounded-md px-4 py-2.5 text-sm font-semibold opacity-70"
            style={{
              backgroundColor: theme.colors?.button ?? primary,
              color: theme.colors?.buttonText ?? "#0b0e14",
            }}
          >
            {theme.welcome?.buttonText ?? "Submit application"}
          </button>
        </div>
      </Card>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      {children}
    </main>
  );
}
