"use client";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

const BUCKET_SIZE = 3;

export function IlvlDistributionWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });

  if (q.isPending) {
    return (
      <WidgetShell title="iLvL distribution">
        <WidgetLoading />
      </WidgetShell>
    );
  }
  if (q.error) {
    return (
      <WidgetShell title="iLvL distribution">
        <WidgetError message={q.error.message} />
      </WidgetShell>
    );
  }

  const ilvls = q.data.members
    .map(
      (m) =>
        m.latest.equipment?.itemLevel ?? m.latest.character?.itemLevel ?? null,
    )
    .filter((v): v is number => typeof v === "number" && v > 0);

  if (ilvls.length === 0) {
    return (
      <WidgetShell title="iLvL distribution">
        <WidgetEmpty>No item-level data yet. Trigger a Tier A sync.</WidgetEmpty>
      </WidgetShell>
    );
  }

  const min = Math.min(...ilvls);
  const max = Math.max(...ilvls);
  const avg = Math.round(ilvls.reduce((s, x) => s + x, 0) / ilvls.length);

  // Bucketize into runs of BUCKET_SIZE ilvls, anchored at the floor.
  const floor = Math.floor(min / BUCKET_SIZE) * BUCKET_SIZE;
  const buckets = new Map<number, number>();
  for (const v of ilvls) {
    const key = Math.floor(v / BUCKET_SIZE) * BUCKET_SIZE;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const bars: Array<{ start: number; count: number }> = [];
  for (let b = floor; b <= max; b += BUCKET_SIZE) {
    bars.push({ start: b, count: buckets.get(b) ?? 0 });
  }
  const peak = Math.max(...bars.map((b) => b.count));

  return (
    <WidgetShell
      title="iLvL distribution"
      description="Histogram of equipped item levels across the team."
    >
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-xs">
          <Stat label="Min" value={min} />
          <Stat label="Mean" value={avg} />
          <Stat label="Max" value={max} />
        </div>
        <div className="space-y-1">
          {bars.map((bar) => (
            <div
              key={bar.start}
              className="flex items-center gap-2 text-xs font-mono"
            >
              <span className="text-muted-foreground min-w-12">
                {bar.start}–{bar.start + BUCKET_SIZE - 1}
              </span>
              <div className="bg-muted relative h-3 flex-1 overflow-hidden rounded">
                <div
                  className="bg-primary h-full"
                  style={{
                    width:
                      bar.count === 0 ? "0%" : `${(bar.count / peak) * 100}%`,
                  }}
                />
              </div>
              <span className="text-muted-foreground tabular-nums min-w-6 text-right">
                {bar.count}
              </span>
            </div>
          ))}
        </div>
      </div>
    </WidgetShell>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border p-2">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
