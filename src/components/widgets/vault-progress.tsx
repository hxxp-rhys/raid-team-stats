"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

type Track = "veteran" | "champion" | "hero" | "myth";

type VaultCategory = {
  unlocked?: number;
  total?: number;
  tracks?: Track[];
  // World vault: Blizzard's public API doesn't expose Delve progress.
  // tracked:false → render slots as "unknown" with a hint, not 0/3.
  tracked?: boolean;
};
type VaultSlots = {
  raid?: VaultCategory;
  mythicPlus?: VaultCategory;
  world?: VaultCategory;
} | null | undefined;

// Gear-track → pip colour. Matches WoW reward-track conventions:
//   veteran = green · champion = blue · hero = light purple · myth = light orange
const TRACK_PIP: Record<Track, string> = {
  veteran: "bg-green-500",
  champion: "bg-blue-500",
  hero: "bg-purple-400",
  myth: "bg-orange-400",
};

/**
 * Three rows per character — raid / M+ / world vault categories.
 * Each unlocked slot is coloured by the gear track it rewards (derived in
 * the Tier-A vault snapshot from key level / raid difficulty). Empty slots
 * are outlined pips. Title attribute names the track for hover detail.
 */
function Pips({
  unlocked,
  total,
  tracks,
  tracked = true,
}: {
  unlocked: number;
  total: number;
  tracks?: Track[];
  tracked?: boolean;
}) {
  if (total <= 0) return <span className="text-muted-foreground text-xs">—</span>;
  // World vault: slots exist but progress isn't observable via the public
  // API. Show dim dashed placeholders + a hint instead of a false 0/3.
  if (!tracked) {
    return (
      <span
        className="inline-flex items-center gap-0.5"
        title="World (Delve) vault progress isn't exposed by Blizzard's public API"
      >
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className="border-muted-foreground/30 inline-block size-2.5 rounded-full border border-dashed"
          />
        ))}
        <span className="text-muted-foreground ml-1 text-[10px]">n/a</span>
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
      description="Slots unlocked this reset (raid / M+ / world)."
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
              const slots = (m.latest.vault?.slots ?? null) as VaultSlots;
              const raid = slots?.raid ?? { unlocked: 0, total: 0 };
              const mp = slots?.mythicPlus ?? { unlocked: 0, total: 0 };
              const wo = slots?.world ?? {
                unlocked: 0,
                total: 3,
                tracked: false,
              };
              return (
                <tr key={m.character.id}>
                  <td className="py-1.5 pr-3 font-medium">{m.character.name}</td>
                  <td className="py-1.5 pr-3">
                    <Pips
                      unlocked={raid.unlocked ?? 0}
                      total={raid.total ?? 3}
                      tracks={raid.tracks}
                    />
                  </td>
                  <td className="py-1.5 pr-3">
                    <Pips
                      unlocked={mp.unlocked ?? 0}
                      total={mp.total ?? 3}
                      tracks={mp.tracks}
                    />
                  </td>
                  <td className="py-1.5 pr-3">
                    <Pips
                      unlocked={wo.unlocked ?? 0}
                      total={wo.total ?? 3}
                      tracks={wo.tracks}
                      tracked={wo.tracked ?? false}
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
