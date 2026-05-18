"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Talent build audit — the actual copy/paste loadout import string per
 * member (the Blizzard API only returns an opaque tree blob). One-click
 * copy to paste into the in-game talent UI or a build site for a spotcheck.
 */
export function TalentBuildsWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (id: string, str: string) => {
    try {
      await navigator.clipboard.writeText(str);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      /* clipboard blocked — the string is still shown for manual copy */
    }
  };

  return (
    <WidgetShell
      title="Talent builds"
      description="Copy/paste loadout strings per member. Needs the in-game uploader."
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">
            Talent loadout import string per character
          </caption>
          <thead>
            <tr className="border-border text-muted-foreground border-b text-xs uppercase">
              <th scope="col" className="py-1 pr-3 text-left font-medium">
                Character
              </th>
              <th scope="col" className="py-1 pr-3 text-left font-medium">
                Spec
              </th>
              <th scope="col" className="py-1 pl-3 text-right font-medium">
                Loadout
              </th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {q.data.members.map((m) => {
              const str = m.latest.addon?.talents?.importString ?? null;
              return (
                <tr key={m.character.id}>
                  <th
                    scope="row"
                    className="max-w-[9rem] truncate py-1.5 pr-3 text-left font-medium"
                  >
                    {m.character.name}
                  </th>
                  <td className="text-muted-foreground py-1.5 pr-3">
                    {m.latest.character?.specName ?? "—"}
                  </td>
                  <td className="py-1.5 pl-3 text-right">
                    {str ? (
                      <span className="inline-flex items-center gap-2">
                        <code className="bg-muted/50 max-w-[10rem] truncate rounded px-1 py-0.5 font-mono text-xs">
                          {str}
                        </code>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => copy(m.character.id, str)}
                        >
                          {copied === m.character.id ? "Copied" : "Copy"}
                        </Button>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </WidgetShell>
  );
}
