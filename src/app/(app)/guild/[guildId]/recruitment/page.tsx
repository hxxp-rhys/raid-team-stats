"use client";

import { Suspense, use, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { api } from "@/lib/trpc-client";
import { SubmissionsModal } from "@/components/recruitment/submissions-modal";
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
  const utils = api.useUtils();
  const forms = api.recruitment.listForms.useQuery({ guildId });
  const [name, setName] = useState("");
  const [subFor, setSubFor] = useState<{
    id: string;
    name: string;
    votingEnabled: boolean;
  } | null>(null);

  const create = api.recruitment.createForm.useMutation({
    onSuccess: async (f) => {
      setName("");
      await utils.recruitment.listForms.invalidate({ guildId });
      router.push(`/guild/${guildId}/recruitment/${f.id}`);
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
                  href={`/guild/${guildId}/recruitment/${f.id}`}
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
                  href={`/guild/${guildId}/recruitment/${f.id}`}
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                >
                  Manage
                </Link>
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
    </main>
  );
}
