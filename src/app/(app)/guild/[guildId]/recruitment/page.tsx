"use client";

import { Suspense, use, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";

import { api } from "@/lib/trpc-client";
import { SubmissionsModal } from "@/components/recruitment/submissions-modal";
import { DangerZoneModal } from "@/components/ui/danger-zone-modal";
import { Modal } from "@/components/ui/modal";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Params = Promise<{ guildId: string }>;

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  OPEN: "Open",
  CLOSED: "Closed",
  ARCHIVED: "Archived",
};

export default function RecruitmentListPage({ params }: { params: Params }) {
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
  const { guildId } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  // When opened from a team dashboard the link carries ?team=<id>, so the back
  // link returns there; otherwise it falls back to the guild page.
  const team = searchParams.get("team");
  // Thread the team context into links to the form builder so its "All forms"
  // back link returns here WITH ?team — keeping the "← Dashboard" back link
  // instead of degrading to "← Guild".
  const teamQuery = team ? `?team=${team}` : "";
  const utils = api.useUtils();
  const forms = api.recruitment.listForms.useQuery({ guildId });
  const [name, setName] = useState("");
  const [subFor, setSubFor] = useState<{
    id: string;
    name: string;
    votingEnabled: boolean;
  } | null>(null);
  const [delFor, setDelFor] = useState<{
    id: string;
    name: string;
    count: number;
  } | null>(null);

  const create = api.recruitment.createForm.useMutation({
    onSuccess: async (f) => {
      setName("");
      await utils.recruitment.listForms.invalidate({ guildId });
      router.push(`/guild/${guildId}/recruitment/${f.id}${teamQuery}` as Route);
    },
  });

  const remove = api.recruitment.removeForm.useMutation({
    onSuccess: async () => {
      setDelFor(null);
      await utils.recruitment.listForms.invalidate({ guildId });
    },
  });

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6">
        <Link
          href={team ? `/guild/${guildId}/team/${team}` : `/guild/${guildId}`}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          ← {team ? "Dashboard" : "Guild"}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Recruitment</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Build a branded application form, share its public link, and review
          applicants with your officers.
        </p>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">New form</CardTitle>
          <CardDescription>
            Creates a draft you can customize, then publish.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate({ guildId, name: name.trim() });
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Mythic Raid Recruitment"
              className="h-9 flex-1"
            />
            <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </form>
          {create.error && (
            <p className="text-destructive mt-2 text-xs">{create.error.message}</p>
          )}
        </CardContent>
      </Card>

      {forms.isPending ? (
        <p className="text-muted-foreground text-sm">Loading forms…</p>
      ) : forms.error ? (
        <p className="text-destructive text-sm">{forms.error.message}</p>
      ) : forms.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">No forms yet.</p>
      ) : (
        <ul className="divide-border divide-y rounded-lg border">
          {forms.data.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <Link
                  href={`/guild/${guildId}/recruitment/${f.id}${teamQuery}` as Route}
                  className="font-medium hover:underline"
                >
                  {f.name}
                </Link>
                <div className="text-muted-foreground mt-0.5 text-xs">
                  {STATUS_LABEL[f.status] ?? f.status} · {f._count.submissions}{" "}
                  submission{f._count.submissions === 1 ? "" : "s"}
                  {f.status === "OPEN" && (
                    <>
                      {" · "}
                      <Link
                        href={`/apply/${guildId}/${f.slug}`}
                        className="text-sky-500 hover:underline"
                        target="_blank"
                      >
                        public link
                      </Link>
                    </>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setSubFor({
                      id: f.id,
                      name: f.name,
                      votingEnabled: f.votingEnabled,
                    })
                  }
                >
                  Submissions
                  {f._count.submissions > 0 && (
                    <span className="text-muted-foreground ml-1.5 text-xs">
                      {f._count.submissions}
                    </span>
                  )}
                </Button>
                <Link
                  href={`/guild/${guildId}/recruitment/${f.id}${teamQuery}` as Route}
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                >
                  Manage
                </Link>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    // Clear any stale error so a freshly opened dialog never
                    // shows a previous attempt's failure.
                    remove.reset();
                    setDelFor({
                      id: f.id,
                      name: f.name,
                      count: f._count.submissions,
                    });
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {subFor && (
        <SubmissionsModal
          open
          formId={subFor.id}
          formName={subFor.name}
          votingEnabled={subFor.votingEnabled}
          onClose={() => setSubFor(null)}
        />
      )}

      {/* Graduated confirmation: a form holding real applicant data demands the
          type-the-name Danger Zone (matches guild/team deletion); an empty form
          (nothing to lose) gets a single-click confirm so discarding a freshly
          created draft isn't a chore. */}
      {delFor && delFor.count > 0 && (
        <DangerZoneModal
          open
          onClose={() => setDelFor(null)}
          title={`Delete "${delFor.name}"`}
          description={
            <>
              Permanently removes this recruitment form, its public application
              link, and all {delFor.count} submission
              {delFor.count === 1 ? "" : "s"} (plus every review) it has
              received. This cannot be undone.
            </>
          }
          expectedConfirm={delFor.name}
          onConfirm={() => remove.mutate({ formId: delFor.id })}
          isPending={remove.isPending}
          errorMessage={remove.error?.message ?? null}
          confirmLabel={`Delete "${delFor.name}"`}
          submittingLabel="Deleting…"
        />
      )}

      {delFor && delFor.count === 0 && (
        <Modal
          open
          // Don't dismiss (and swallow an error) mid-delete.
          onClose={() => {
            if (!remove.isPending) setDelFor(null);
          }}
          title={`Delete "${delFor.name}"?`}
          hideDefaultFooter
          className="max-w-md"
        >
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              This form has no submissions. Deleting it also removes its public
              application link. This cannot be undone.
            </p>
            {remove.error && (
              <p className="text-destructive text-sm" role="alert">
                {remove.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setDelFor(null)}
                disabled={remove.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => remove.mutate({ formId: delFor.id })}
                disabled={remove.isPending}
              >
                {remove.isPending ? "Deleting…" : "Delete"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}
