"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Talent build audit — links each member's current loadout straight into
 * the Wowhead talent calculator (it decodes the Blizzard import string
 * from the URL), so a build spotcheck is one click, no copy/paste.
 */
export function TalentBuildsWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Talent builds"
      description="Each member's current loadout, linked to the talent calculator."
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Talent loadout per character</caption>
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
              // Blizzard /specializations is the source (the in-game addon
              // can't read the loadout on WoW 12.0); fall back to an addon
              // import string if an older upload still carries one.
              const str =
                m.latest.character?.loadoutText ??
                m.latest.addon?.talents?.importString ??
                null;
              // Wowhead expects the RAW Blizzard import string in the path
              // (it base64-decodes it). encodeURIComponent breaks the `+`
              // that ~half of loadout strings contain — pass it verbatim.
              const href = str
                ? `https://www.wowhead.com/talent-calc/blizzard/${str}`
                : null;
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
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary font-medium hover:underline"
                      >
                        View build ↗
                      </a>
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
