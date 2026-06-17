"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";

const STATUS_OPTIONS = [
  "NEW",
  "UNDER_REVIEW",
  "TRIAL_OFFERED",
  "ACCEPTED",
  "DECLINED",
  "WITHDRAWN",
] as const;

/**
 * Applicant-review lightboxes for a recruitment form. `SubmissionsModal` lists
 * the form's applications; clicking one opens a second, stacked lightbox with
 * the full application (answers, status, voting, notes). Used from the
 * Recruitment list page — the form-management page now only owns notification
 * opt-in, not the inbox.
 */
export function SubmissionsModal({
  formId,
  formName,
  votingEnabled,
  open,
  onClose,
}: {
  formId: string;
  formName: string;
  votingEnabled: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const subs = api.recruitment.listSubmissions.useQuery(
    { formId },
    { enabled: open },
  );
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={`Submissions — ${formName}`}
        description="Click an application to review it."
        showCloseIcon
        hideDefaultFooter
      >
        {subs.isPending ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : subs.error ? (
          <p className="text-destructive text-sm">{subs.error.message}</p>
        ) : subs.data.length === 0 ? (
          <p className="text-muted-foreground text-sm">No applications yet.</p>
        ) : (
          <ul className="divide-border divide-y">
            {subs.data.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => setSelected(s.id)}
                  className="hover:bg-muted -mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-md px-2 py-2.5 text-left text-sm transition-colors"
                >
                  <span className="min-w-0">
                    <span className="font-medium">
                      {s.applicantLabel ?? "Applicant"}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {s.status.toLowerCase().replace("_", " ")}
                      {votingEnabled &&
                        s._count.votes > 0 &&
                        ` · ${s._count.votes} vote(s)`}
                    </span>
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {s.submittedAt
                      ? new Date(s.submittedAt).toLocaleDateString()
                      : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <Modal
        open={selected != null}
        onClose={() => setSelected(null)}
        title="Application"
        showCloseIcon
        hideDefaultFooter
      >
        {selected && <SubmissionDetail submissionId={selected} />}
      </Modal>
    </>
  );
}

export function SubmissionDetail({ submissionId }: { submissionId: string }) {
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
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{s.applicantLabel ?? "Applicant"}</h3>
        <select
          className="border-border bg-background h-8 rounded-md border px-2 text-xs"
          value={s.status}
          onChange={(e) =>
            setStatus.mutate({
              submissionId,
              status: e.target.value as (typeof STATUS_OPTIONS)[number],
            })
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
            {(["STRONG_NO", "NO", "YES", "STRONG_YES", "ABSTAIN"] as const).map(
              (v) => (
                <button
                  key={v}
                  onClick={() => {
                    if (!rationale.trim()) {
                      alert("Add a brief rationale with your vote.");
                      return;
                    }
                    vote.mutate({
                      submissionId,
                      value: v,
                      rationale: rationale.trim(),
                    });
                  }}
                  className={`rounded-md border px-2 py-1 text-xs ${
                    s.voting.myVote?.value === v
                      ? "bg-primary text-primary-foreground"
                      : ""
                  }`}
                >
                  {v.toLowerCase().replace("_", " ")}
                </button>
              ),
            )}
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
              <span className="font-medium">
                {c.author.displayName ?? "Officer"}
              </span>
              : {c.body}
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
