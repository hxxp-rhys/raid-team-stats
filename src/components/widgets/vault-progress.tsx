"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";
import { GEAR_TRACK_BG, type GearTrack } from "@/lib/gear-tracks";

// Gear-track → pip colour. Single source of truth in @/lib/gear-tracks
// per the project brand spec (Adventurer/Veteran/Champion/Hero/Myth =
// gray/green/blue/purple/orange).
const TRACK_PIP = GEAR_TRACK_BG;

/**
 * Three rows per character — raid / M+ / world vault categories.
 * Each unlocked slot is coloured by the gear track it rewards when known.
 * Empty slots are outlined pips. Title attribute names the track for hover
 * detail.
 */
function Pips({
  unlocked,
  total,
  tracks,
  tracked = true,
}: {
  unlocked: number;
  total: number;
  tracks?: GearTrack[];
  tracked?: boolean;
}) {
  if (total <= 0) return <span className="text-muted-foreground text-xs">—</span>;
  // Without an addon upload there is NO Great Vault data at all (no Blizzard
  // web API exposes the vault — raid, M+, or World/Delve). Label the row
  // explicitly rather than fake a 0/3.
  if (!tracked) {
    return (
      <span
        className="inline-flex items-center gap-1"
        title="Blizzard exposes no Great Vault API. Vault progress is fed by the Raid Team Stats in-game addon + companion uploader; install Raid Team Stats from your account page and run the addon to populate it."
      >
        <span className="border-muted-foreground/30 text-muted-foreground rounded border border-dashed px-1.5 py-0.5 text-[10px]">
          Raid Team Stats addon needed
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: total }).map((_, i) => {
        if (i >= unlocked) {
          return (
            <span
              key={i}
              className="border-muted-foreground/40 inline-block size-2.5 rounded-full border"
            />
          );
        }
        const track = tracks?.[i];
        const color = track ? TRACK_PIP[track] : "bg-primary";
        return (
          <span
            key={i}
            title={track ? `${track} track` : "unlocked"}
            className={`${color} inline-block size-2.5 rounded-full`}
          />
        );
      })}
    </span>
  );
}

export function VaultProgressWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  return (
    <WidgetShell
      title="Great Vault progress"
      description="Vault slots unlocked this reset across Raid, M+, and World/Delve. Addon-only — no Blizzard web API exposes the Great Vault; rows show only when the character's owner runs the Raid Team Stats addon."
    >
      {q.isPending ? (
        <WidgetLoading />
      ) : q.error ? (
        <WidgetError message={q.error.message} />
      ) : q.data.members.length === 0 ? (
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Vault progress</caption>
          <thead>
            <tr className="text-muted-foreground text-left text-xs uppercase">
              <th scope="col" className="py-1 pr-3 font-medium">
                Character
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Raid
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                M+
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                World
              </th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {q.data.members.map((m) => {
              // Source every row from the addon's deriveVaultDetail output —
              // the SAME data the Great Vault detail widget reads — so the two
              // widgets always agree on unlocked/total. Each category is
              // {kind, rows:[{unlocked,…}]}; per-category unlocked is the count
              // of unlocked rows, total is the row count.
              const cats = m.latest.addon?.vault ?? null;
              const catFor = (kind: "raid" | "mplus" | "world") => {
                const cat = cats?.find((c) => c.kind === kind) ?? null;
                if (!cat || cat.rows.length === 0) return null;
                return {
                  unlocked: cat.rows.filter((r) => r.unlocked).length,
                  total: cat.rows.length,
                };
              };
              // No addon upload (or an empty vault) → no Great Vault data at
              // all. Render the "addon needed" affordance in every row.
              const hasAddon = cats != null;
              const raid = catFor("raid");
              const mp = catFor("mplus");
              const wo = catFor("world");
              return (
                <tr key={m.character.id}>
                  <td className="py-1.5 pr-3 font-medium">{m.character.name}</td>
                  <td className="py-1.5 pr-3">
                    <Pips
                      unlocked={raid?.unlocked ?? 0}
                      total={raid?.total ?? 3}
                      tracked={hasAddon && raid != null}
                    />
                  </td>
                  <td className="py-1.5 pr-3">
                    <Pips
                      unlocked={mp?.unlocked ?? 0}
                      total={mp?.total ?? 3}
                      tracked={hasAddon && mp != null}
                    />
                  </td>
                  <td className="py-1.5 pr-3">
                    <Pips
                      unlocked={wo?.unlocked ?? 0}
                      total={wo?.total ?? 3}
                      tracked={hasAddon && wo != null}
                    />
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
