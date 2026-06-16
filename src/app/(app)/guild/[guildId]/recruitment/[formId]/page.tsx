"use client";

import { Suspense, use, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { api, type RouterOutputs } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FIELD_TYPES,
  formStructureSchema,
  type Field,
  type FieldType,
  type FormStructure,
} from "@/lib/recruitment/form-schema";

type Params = Promise<{ guildId: string; formId: string }>;

const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  SHORT_TEXT: "Short text",
  LONG_TEXT: "Long text",
  EMAIL: "Email",
  NUMBER: "Number",
  URL: "URL",
  SINGLE_SELECT: "Single select",
  DROPDOWN: "Dropdown",
  MULTI_SELECT: "Multi select",
  YES_NO: "Yes / No",
  RATING: "Rating",
  LINEAR_SCALE: "Scale",
  DATE: "Date",
  HEADING: "Heading",
  DIVIDER: "Divider",
  RICH_TEXT: "Info text",
};
const HAS_OPTIONS = (t: FieldType) =>
  t === "SINGLE_SELECT" || t === "DROPDOWN" || t === "MULTI_SELECT";

export default function RecruitmentFormPage({ params }: { params: Params }) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-4xl px-4 py-12">
          <p className="text-muted-foreground text-sm">Loading…</p>
        </main>
      }
    >
      <Inner params={params} />
    </Suspense>
  );
}

function Inner({ params }: { params: Params }) {
  const { guildId, formId } = use(params);
  const [tab, setTab] = useState<"build" | "inbox">("build");
  const form = api.recruitment.getForm.useQuery({ formId });

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-4">
        <Link
          href={`/guild/${guildId}/recruitment`}
          className="text-muted-foreground text-xs hover:underline"
        >
          ← All forms
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">
          {form.data?.name ?? "Form"}
        </h1>
      </div>

      <div className="border-border mb-5 flex gap-1 border-b">
        {(["build", "inbox"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium ${
              tab === t
                ? "border-primary border-b-2"
                : "text-muted-foreground"
            }`}
          >
            {t === "build" ? "Build & settings" : "Submissions"}
          </button>
        ))}
      </div>

      {form.isPending ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : form.error ? (
        <p className="text-destructive text-sm">{form.error.message}</p>
      ) : tab === "build" ? (
        <Builder guildId={guildId} formId={formId} form={form.data} />
      ) : (
        <Inbox formId={formId} votingEnabled={form.data.votingEnabled} />
      )}
    </main>
  );
}

// ── Build & settings ────────────────────────────────────────────────────────

type FormData = RouterOutputs["recruitment"]["getForm"];

function Builder({
  guildId,
  formId,
  form,
}: {
  guildId: string;
  formId: string;
  form: FormData;
}) {
  const utils = api.useUtils();
  const update = api.recruitment.updateForm.useMutation({
    onSuccess: () => utils.recruitment.getForm.invalidate({ formId }),
  });

  const initial = useMemo<FormStructure>(() => {
    const r = formStructureSchema.safeParse(form.schema);
    return r.success
      ? r.data
      : formStructureSchema.parse({ pages: [{ id: "p1", fields: [] }] });
  }, [form.schema]);

  // Edit a single flattened field list (v1 = one page).
  const [fields, setFields] = useState<Field[]>(initial.pages.flatMap((p) => p.fields));
  const [status, setStatus] = useState(form.status);
  const [slug, setSlug] = useState(form.slug);
  // Monotonic id source for new fields/options, seeded past any existing
  // `nf<n>` ids so it stays collision-free across reloads (no Math.random,
  // which the purity lint rule forbids in component scope).
  const idSeq = useRef(
    fields.reduce((m, f) => {
      const n = /^nf(\d+)$/.exec(f.id);
      return n ? Math.max(m, Number(n[1]) + 1) : m;
    }, 0),
  );
  const genId = (prefix: string) => `${prefix}${idSeq.current++}`;

  const saveStructure = () => {
    const structure = {
      ...initial,
      pages: [{ id: initial.pages[0]?.id ?? "p1", title: initial.pages[0]?.title, fields }],
    };
    const parsed = formStructureSchema.safeParse(structure);
    if (!parsed.success) {
      alert("Form has invalid fields — check labels/options.");
      return;
    }
    update.mutate({ formId, schema: parsed.data });
  };

  const addField = (type: FieldType) => {
    setFields((fs) => [
      ...fs,
      {
        id: genId("nf"),
        type,
        label: FIELD_TYPE_LABEL[type],
        ...(HAS_OPTIONS(type)
          ? { options: [{ id: "o1", label: "Option 1", value: "option-1" }] }
          : {}),
      } as Field,
    ]);
  };
  const patchField = (i: number, patch: Partial<Field>) =>
    setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const removeField = (i: number) =>
    setFields((fs) => fs.filter((_, j) => j !== i));
  const move = (i: number, dir: -1 | 1) =>
    setFields((fs) => {
      const j = i + dir;
      if (j < 0 || j >= fs.length) return fs;
      const next = [...fs];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  return (
    <div className="space-y-6">
      {/* Status + link */}
      <section className="border-border rounded-lg border p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase">Status</label>
            <select
              className="border-border bg-background h-9 rounded-md border px-2 text-sm"
              value={status}
              onChange={(e) => {
                const s = e.target.value as
                  | "DRAFT"
                  | "OPEN"
                  | "CLOSED"
                  | "ARCHIVED";
                setStatus(s);
                update.mutate({ formId, status: s });
              }}
            >
              <option value="DRAFT">Draft</option>
              <option value="OPEN">Open (accepting applications)</option>
              <option value="CLOSED">Closed</option>
              <option value="ARCHIVED">Archived</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium uppercase">Public link slug</label>
            <div className="flex items-center gap-2">
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="h-9"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => update.mutate({ formId, slug })}
                disabled={update.isPending}
              >
                Save slug
              </Button>
            </div>
            {status === "OPEN" && (
              <Link
                href={`/apply/${guildId}/${form.slug}`}
                target="_blank"
                className="text-sky-500 mt-1 inline-block text-xs hover:underline"
              >
                /apply/{guildId}/{form.slug} ↗
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* Voting toggle */}
      <section className="border-border flex items-center justify-between rounded-lg border p-4">
        <div>
          <p className="text-sm font-medium">Reviewer voting</p>
          <p className="text-muted-foreground text-xs">
            Let officers vote on applicants (hidden until they cast their own vote).
            Off by default.
          </p>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.votingEnabled}
            onChange={(e) => update.mutate({ formId, votingEnabled: e.target.checked })}
          />
          {form.votingEnabled ? "On" : "Off"}
        </label>
      </section>

      {/* Theme (basic) */}
      <ThemeEditor formId={formId} form={form} update={update} />

      {/* Fields */}
      <section className="border-border rounded-lg border p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Questions</h2>
          <Button size="sm" onClick={saveStructure} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save questions"}
          </Button>
        </div>

        <ul className="space-y-3">
          {fields.map((f, i) => (
            <li key={f.id} className="border-border rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={f.label}
                  onChange={(e) => patchField(i, { label: e.target.value })}
                  className="h-8 flex-1"
                  placeholder="Question label"
                />
                <select
                  className="border-border bg-background h-8 rounded-md border px-2 text-xs"
                  value={f.type}
                  onChange={(e) => patchField(i, { type: e.target.value as FieldType })}
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {FIELD_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={!!f.required}
                    onChange={(e) => patchField(i, { required: e.target.checked })}
                  />
                  Required
                </label>
                <button
                  className="text-muted-foreground px-1 text-sm"
                  onClick={() => move(i, -1)}
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  className="text-muted-foreground px-1 text-sm"
                  onClick={() => move(i, 1)}
                  title="Move down"
                >
                  ↓
                </button>
                <button
                  className="text-destructive px-1 text-xs"
                  onClick={() => removeField(i)}
                >
                  Remove
                </button>
              </div>
              {HAS_OPTIONS(f.type) && (
                <OptionsEditor
                  field={f}
                  onChange={(options) => patchField(i, { options })}
                />
              )}
            </li>
          ))}
        </ul>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {FIELD_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => addField(t)}
              className="border-border rounded-md border px-2 py-1 text-xs"
            >
              + {FIELD_TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </section>

      {update.error && (
        <p className="text-destructive text-sm">{update.error.message}</p>
      )}
    </div>
  );
}

function OptionsEditor({
  field,
  onChange,
}: {
  field: Field;
  onChange: (options: Field["options"]) => void;
}) {
  const opts = field.options ?? [];
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "opt";
  return (
    <div className="mt-2 space-y-1 pl-2">
      {opts.map((o, i) => (
        <div key={o.id} className="flex items-center gap-2">
          <Input
            value={o.label}
            onChange={(e) =>
              onChange(
                opts.map((x, j) =>
                  j === i
                    ? { ...x, label: e.target.value, value: slug(e.target.value) }
                    : x,
                ),
              )
            }
            className="h-7 flex-1 text-xs"
            placeholder={`Option ${i + 1}`}
          />
          <button
            className="text-destructive text-xs"
            onClick={() => onChange(opts.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="text-sky-500 text-xs"
        onClick={() => {
          // pure next-id past any existing o<n> (no Math.random in render scope)
          const nextN = opts.reduce((m, o) => {
            const n = /^o(\d+)$/.exec(o.id);
            return n ? Math.max(m, Number(n[1]) + 1) : m;
          }, 1);
          onChange([
            ...opts,
            { id: `o${nextN}`, label: "New option", value: "new-option" },
          ]);
        }}
      >
        + option
      </button>
    </div>
  );
}

function ThemeEditor({
  formId,
  form,
  update,
}: {
  formId: string;
  form: FormData;
  update: ReturnType<typeof api.recruitment.updateForm.useMutation>;
}) {
  const initial = (form.theme ?? {}) as Record<string, unknown>;
  const [logoUrl, setLogoUrl] = useState(
    typeof initial.logoUrl === "string" ? initial.logoUrl : "",
  );
  const colors = (initial.colors ?? {}) as Record<string, string>;
  const bg = (initial.background ?? {}) as Record<string, string>;
  const [primary, setPrimary] = useState(colors.primary ?? "#c8a04f");
  const [bgColor, setBgColor] = useState(bg.color ?? "#0b0e14");

  const save = () =>
    update.mutate({
      formId,
      theme: {
        ...(logoUrl ? { logoUrl } : {}),
        colors: { primary },
        background: { kind: "color", color: bgColor },
      },
    });

  return (
    <section className="border-border rounded-lg border p-4">
      <h2 className="mb-3 text-sm font-semibold">Branding</h2>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex-1">
          <label className="mb-1 block text-xs font-medium uppercase">Logo URL</label>
          <Input
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://…/logo.png"
            className="h-9"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase">Accent</label>
          <input
            type="color"
            value={primary}
            onChange={(e) => setPrimary(e.target.value)}
            className="h-9 w-12"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase">Background</label>
          <input
            type="color"
            value={bgColor}
            onChange={(e) => setBgColor(e.target.value)}
            className="h-9 w-12"
          />
        </div>
        <Button size="sm" variant="outline" onClick={save} disabled={update.isPending}>
          Save branding
        </Button>
      </div>
    </section>
  );
}

// ── Inbox ───────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  "NEW",
  "UNDER_REVIEW",
  "TRIAL_OFFERED",
  "ACCEPTED",
  "DECLINED",
  "WITHDRAWN",
] as const;

function Inbox({
  formId,
  votingEnabled,
}: {
  formId: string;
  votingEnabled: boolean;
}) {
  const subs = api.recruitment.listSubmissions.useQuery({ formId });
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <NotifyOptIn formId={formId} />
      {subs.isPending ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : subs.error ? (
        <p className="text-destructive text-sm">{subs.error.message}</p>
      ) : subs.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">No submissions yet.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
          <ul className="divide-border divide-y rounded-lg border">
            {subs.data.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => setSelected(s.id)}
                  className={`w-full px-3 py-2 text-left text-sm ${
                    selected === s.id ? "bg-muted" : ""
                  }`}
                >
                  <span className="font-medium">{s.applicantLabel ?? "Applicant"}</span>
                  <span className="text-muted-foreground block text-xs">
                    {s.status.toLowerCase().replace("_", " ")}
                    {votingEnabled && s._count.votes > 0 && ` · ${s._count.votes} vote(s)`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div>
            {selected ? (
              <SubmissionDetail submissionId={selected} />
            ) : (
              <p className="text-muted-foreground text-sm">
                Select a submission to review.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SubmissionDetail({ submissionId }: { submissionId: string }) {
  const utils = api.useUtils();
  const q = api.recruitment.getSubmission.useQuery({ submissionId });
  const setStatus = api.recruitment.setSubmissionStatus.useMutation({
    onSuccess: () => {
      void utils.recruitment.getSubmission.invalidate({ submissionId });
      void utils.recruitment.listSubmissions.invalidate();
    },
  });
  const vote = api.recruitment.vote.useMutation({
    onSuccess: () => utils.recruitment.getSubmission.invalidate({ submissionId }),
  });
  const comment = api.recruitment.addComment.useMutation({
    onSuccess: () => utils.recruitment.getSubmission.invalidate({ submissionId }),
  });

  const [rationale, setRationale] = useState("");
  const [body, setBody] = useState("");

  if (q.isPending) return <p className="text-muted-foreground text-sm">Loading…</p>;
  if (q.error) return <p className="text-destructive text-sm">{q.error.message}</p>;
  const s = q.data;

  return (
    <div className="border-border space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{s.applicantLabel ?? "Applicant"}</h3>
        <select
          className="border-border bg-background h-8 rounded-md border px-2 text-xs"
          value={s.status}
          onChange={(e) =>
            setStatus.mutate({ submissionId, status: e.target.value as (typeof STATUS_OPTIONS)[number] })
          }
        >
          {STATUS_OPTIONS.map((st) => (
            <option key={st} value={st}>
              {st.toLowerCase().replace("_", " ")}
            </option>
          ))}
        </select>
      </div>

      <dl className="space-y-2 text-sm">
        {s.answers.map((a) => (
          <div key={a.fieldId}>
            <dt className="text-muted-foreground text-xs">{a.label}</dt>
            <dd>
              {a.valueText ??
                (a.valueNumber != null ? String(a.valueNumber) : "—")}
            </dd>
          </div>
        ))}
      </dl>

      {s.voting.enabled && (
        <div className="border-border border-t pt-3">
          <p className="mb-2 text-xs font-medium uppercase">
            Voting{" "}
            <span className="text-muted-foreground">
              ({s.voting.voterCount} cast)
            </span>
          </p>
          {!s.voting.revealed && (
            <p className="text-muted-foreground mb-2 text-xs">
              Others&apos; votes are hidden until you cast yours.
            </p>
          )}
          <div className="mb-2 flex flex-wrap gap-1.5">
            {(["STRONG_NO", "NO", "YES", "STRONG_YES", "ABSTAIN"] as const).map((v) => (
              <button
                key={v}
                onClick={() => {
                  if (!rationale.trim()) {
                    alert("Add a brief rationale with your vote.");
                    return;
                  }
                  vote.mutate({ submissionId, value: v, rationale: rationale.trim() });
                }}
                className={`rounded-md border px-2 py-1 text-xs ${
                  s.voting.myVote?.value === v ? "bg-primary text-primary-foreground" : ""
                }`}
              >
                {v.toLowerCase().replace("_", " ")}
              </button>
            ))}
          </div>
          <Input
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Rationale (required with a vote)"
            className="h-8 text-xs"
          />
          {s.voting.revealed && s.voting.votes.length > 0 && (
            <ul className="mt-2 space-y-1">
              {s.voting.votes.map((v, i) => (
                <li key={i} className="text-xs">
                  <span className="font-medium">{v.reviewer}</span>:{" "}
                  {v.value.toLowerCase().replace("_", " ")} — {v.rationale}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="border-border border-t pt-3">
        <p className="mb-2 text-xs font-medium uppercase">Notes</p>
        <ul className="mb-2 space-y-1">
          {s.comments.map((c) => (
            <li key={c.id} className="text-xs">
              <span className="font-medium">{c.author.displayName ?? "Officer"}</span>:{" "}
              {c.body}
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) {
              comment.mutate({ submissionId, body: body.trim() });
              setBody("");
            }
          }}
        >
          <Input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add a note…"
            className="h-8 text-xs"
          />
          <Button type="submit" size="sm" variant="outline" disabled={!body.trim()}>
            Add
          </Button>
        </form>
      </div>
    </div>
  );
}

function NotifyOptIn({ formId }: { formId: string }) {
  const utils = api.useUtils();
  const prefs = api.recruitment.myNotificationPrefs.useQuery({ formId });
  const setPref = api.recruitment.setNotificationPref.useMutation({
    onSuccess: () => utils.recruitment.myNotificationPrefs.invalidate({ formId }),
  });
  const has = (ch: "EMAIL" | "DISCORD_DM") =>
    !!prefs.data?.some((p) => p.channel === ch);

  return (
    <div className="border-border text-muted-foreground flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2 text-xs">
      <span className="font-medium">Notify me of new applications:</span>
      {(["EMAIL", "DISCORD_DM"] as const).map((ch) => (
        <label key={ch} className="flex cursor-pointer items-center gap-1">
          <input
            type="checkbox"
            checked={has(ch)}
            onChange={(e) =>
              setPref.mutate({
                formId,
                channel: ch,
                onNew: true,
                enabled: e.target.checked,
              })
            }
          />
          {ch === "EMAIL" ? "Email" : "Discord DM"}
        </label>
      ))}
    </div>
  );
}
