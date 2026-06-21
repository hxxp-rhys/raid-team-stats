"use client";

import { Suspense, use, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { api, type RouterOutputs } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { FormPreview } from "@/components/recruitment/public-form";
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

/**
 * The "add a field" buttons — orange (the default Button, matching "Save
 * questions") so they read as the primary build action. Shared by the fixed
 * left rail and the inline (narrow-screen) fallback; `vertical` gives them a
 * uniform width when stacked in the rail.
 */
function FieldPalette({
  onAdd,
  vertical,
}: {
  onAdd: (t: FieldType) => void;
  vertical?: boolean;
}) {
  return (
    <>
      {FIELD_TYPES.map((t) => (
        <Button
          key={t}
          size="sm"
          onClick={() => onAdd(t)}
          className={vertical ? "w-32 justify-start" : ""}
        >
          + {FIELD_TYPE_LABEL[t]}
        </Button>
      ))}
    </>
  );
}

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
  const [tab, setTab] = useState<"build" | "settings">("build");
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
        {(["build", "settings"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium ${
              tab === t
                ? "border-primary border-b-2"
                : "text-muted-foreground"
            }`}
          >
            {t === "build" ? "Build" : "Settings"}
          </button>
        ))}
      </div>

      {form.isPending ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : form.error ? (
        <p className="text-destructive text-sm">{form.error.message}</p>
      ) : tab === "build" ? (
        <BuildTab formId={formId} form={form.data} />
      ) : (
        <SettingsTab guildId={guildId} formId={formId} form={form.data} />
      )}
    </main>
  );
}

// ── Build (questions) ───────────────────────────────────────────────────────

type FormData = RouterOutputs["recruitment"]["getForm"];

function BuildTab({
  formId,
  form,
}: {
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
  const [previewOpen, setPreviewOpen] = useState(false);

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
    <>
      {/* Add-field RAIL — fixed in the left gutter on wide screens, anchored to
          the vertical center of the viewport so it follows scrolling. Pinned by
          its RIGHT edge just left of the centered content, so when the viewport
          is too short the buttons wrap into ADDITIONAL columns that grow
          leftward into the gutter (never over the content). */}
      <aside className="border-border bg-card/90 fixed top-1/2 right-[calc(50%_+_29rem)] z-30 hidden max-h-[85vh] max-w-[calc(50%_-_30rem)] -translate-y-1/2 flex-col gap-2 overflow-auto rounded-lg border p-2 shadow-md backdrop-blur xl:flex">
        <p className="text-muted-foreground px-1 text-[11px] font-medium tracking-wide uppercase">
          Add a field
        </p>
        {/* max-w (= gutter width) keeps the rail's left edge ≥1rem on-screen even
            when it wraps; columns grow leftward into the gutter. Multi-column
            wrapping only kicks in at 2xl, where the gutter is wide enough for a
            second column; at xl a too-tall list scrolls (overflow-auto) so every
            field stays reachable. */}
        <div className="flex flex-col gap-1.5 2xl:max-h-[72vh] 2xl:flex-wrap">
          <FieldPalette onAdd={addField} vertical />
        </div>
      </aside>

      <div className="space-y-6">
        {/* Inline add-field palette — shown on narrower screens with no gutter
            for the fixed rail, so adding fields stays accessible. */}
        <div className="xl:hidden">
          <p className="text-muted-foreground mb-1.5 text-[11px] font-medium tracking-wide uppercase">
            Add a field
          </p>
          <div className="flex flex-wrap gap-1.5">
            <FieldPalette onAdd={addField} />
          </div>
        </div>

        {/* Questions */}
        <section className="border-border rounded-lg border p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Questions</h2>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={saveStructure} disabled={update.isPending}>
                {update.isPending ? "Saving…" : "Save questions"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPreviewOpen(true)}
              >
                Preview
              </Button>
            </div>
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
        </section>

        <Modal
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
          title="Form preview"
          description="How applicants will see this form, using your current questions."
          showCloseIcon
          hideDefaultFooter
          className="max-w-3xl"
        >
          {previewOpen && (
            <FormPreview
              structure={{
                ...initial,
                pages: [
                  {
                    id: initial.pages[0]?.id ?? "p1",
                    title: initial.pages[0]?.title,
                    fields,
                  },
                ],
              }}
              theme={form.theme}
              name={form.name}
            />
          )}
        </Modal>

        {update.error && (
          <p className="text-destructive text-sm">{update.error.message}</p>
        )}
      </div>
    </>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

function SettingsTab({
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
  const [status, setStatus] = useState(form.status);
  const [slug, setSlug] = useState(form.slug);

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
            <p className="text-muted-foreground mt-1 max-w-[15rem] text-xs">
              The public application link appears once the status is set to{" "}
              <span className="text-foreground font-medium">Open</span>.
            </p>
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

      {/* Branding */}
      <ThemeEditor formId={formId} form={form} update={update} />

      {/* Notifications — merged into Settings, under Branding. */}
      <section className="border-border space-y-3 rounded-lg border p-4">
        <div>
          <h2 className="text-sm font-semibold">Notifications</h2>
          <p className="text-muted-foreground text-xs">
            Choose how you want to be alerted about new applications. To read and
            review the applications themselves, use the{" "}
            <span className="text-foreground font-medium">Submissions</span>{" "}
            button on the Recruitment page.
          </p>
        </div>
        <NotifyOptIn formId={formId} />
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

/**
 * Read an image File and return a downscaled JPEG data URL (longest edge capped
 * at `maxDim`). Keeps the payload small enough to live in the form's theme JSON,
 * so a custom background needs no object storage / writable volume.
 */
function fileToDownscaledDataUrl(
  file: File,
  maxDim = 1600,
  quality = 0.82,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error("Could not decode the image."));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas is not supported in this browser."));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
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
  const bg = (initial.background ?? {}) as Record<string, unknown>;
  const [primary, setPrimary] = useState((colors.primary as string) ?? "#c8a04f");
  const [bgColor, setBgColor] = useState((bg.color as string) ?? "#0b0e14");
  const [bgImage, setBgImage] = useState(
    bg.kind === "image" && typeof bg.imageUrl === "string" ? bg.imageUrl : "",
  );
  const [overlay, setOverlay] = useState(
    typeof bg.overlayOpacity === "number" ? bg.overlayOpacity : 0.45,
  );
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickImage = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      alert("Please choose an image file (PNG, JPG, WebP…).");
      return;
    }
    setBusy(true);
    try {
      setBgImage(await fileToDownscaledDataUrl(file));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not load that image.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const save = () =>
    update.mutate({
      formId,
      theme: {
        ...(logoUrl ? { logoUrl } : {}),
        colors: { primary },
        background: bgImage
          ? { kind: "image", imageUrl: bgImage, overlayOpacity: overlay }
          : { kind: "color", color: bgColor },
      },
    });

  return (
    <section className="border-border space-y-4 rounded-lg border p-4">
      <h2 className="text-sm font-semibold">Branding</h2>

      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-[12rem] flex-1">
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
          <label className="mb-1 block text-xs font-medium uppercase">
            Background color
          </label>
          <input
            type="color"
            value={bgColor}
            onChange={(e) => setBgColor(e.target.value)}
            className="h-9 w-12 disabled:opacity-40"
            disabled={!!bgImage}
            title={bgImage ? "Remove the background image to use a color" : undefined}
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium uppercase">
          Background image
        </label>
        <div className="flex flex-wrap items-center gap-3">
          {bgImage && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={bgImage}
              alt="Background preview"
              className="border-border h-12 w-20 rounded border object-cover"
            />
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => onPickImage(e.target.files?.[0])}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || update.isPending}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? "Processing…" : bgImage ? "Replace image" : "Upload image"}
          </Button>
          {bgImage && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setBgImage("")}
            >
              Remove
            </Button>
          )}
        </div>
        {bgImage && (
          <div className="mt-2 max-w-xs">
            <div className="text-muted-foreground flex items-center justify-between text-xs">
              <span>Darken for readability</span>
              <span>{Math.round(overlay * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={0.8}
              step={0.05}
              value={overlay}
              onChange={(e) => setOverlay(Number(e.target.value))}
              className="w-full"
            />
          </div>
        )}
        <p className="text-muted-foreground mt-1 text-xs">
          Shown behind the public application form. Large images are scaled down
          automatically.
        </p>
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={save}
          disabled={update.isPending || busy}
        >
          Save branding
        </Button>
      </div>
    </section>
  );
}

// ── Notifications ────────────────────────────────────────────────────────────

function NotifyOptIn({ formId }: { formId: string }) {
  const utils = api.useUtils();
  const prefs = api.recruitment.myNotificationPrefs.useQuery({ formId });
  const setPref = api.recruitment.setNotificationPref.useMutation({
    onSuccess: () => utils.recruitment.myNotificationPrefs.invalidate({ formId }),
  });
  const has = (ch: "EMAIL" | "DISCORD_DM") =>
    !!prefs.data?.some((p) => p.channel === ch);

  return (
    <div className="text-muted-foreground bg-muted/30 flex flex-wrap items-center gap-3 rounded-md px-3 py-2 text-xs">
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
