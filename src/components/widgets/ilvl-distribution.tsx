"use client";

import { api } from "@/lib/trpc-client";
import { MAX_ITEM_LEVEL } from "@/lib/gear-tracks";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

const BUCKET_SIZE = 3;

/** Yellow warning triangle for an item-level range above the expansion cap. */
function OverCapWarning() {
  return (
    <span
      title={`Above the current expansion's max item level (${MAX_ITEM_LEVEL}) — likely a data anomaly or unaccounted-for new content.`}
      className="text-yellow-500"
      aria-label="above maximum item level"
    >
      <svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
        fill="currentColor"
        aria-hidden="true"
        className="inline-block align-text-top"
      >
        <path d="M12 2 1 21h22L12 2Zm0 6 .9 7h-1.8L12 8Zm0 9.5a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z" />
      </svg>
    </span>
  );
}

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

  // Bucketize into runs of BUCKET_SIZE ilvls. Only POPULATED ranges are shown
  // (empty bins are dropped, not rendered as zero-width bars).
  const buckets = new Map<number, number>();
  for (const v of ilvls) {
    const key = Math.floor(v / BUCKET_SIZE) * BUCKET_SIZE;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const bars = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, count]) => ({ start, count }));
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
          <Stat label="Max" value={max} warn={max > MAX_ITEM_LEVEL} />
        </div>
        <div className="space-y-1">
          {bars.map((bar) => {
            // A range that STARTS above the cap is entirely out-of-expansion.
            const overCap = bar.start > MAX_ITEM_LEVEL;
            return (
            <div
              key={bar.start}
              className="flex items-center gap-2 text-xs font-mono"
            >
              <span className="text-muted-foreground inline-flex min-w-12 items-center gap-0.5">
                {bar.start}–{bar.start + BUCKET_SIZE - 1}
                {overCap && <OverCapWarning />}
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
            );
          })}
        </div>
      </div>
    </WidgetShell>
  );
}

function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: number;
  warn?: boolean;
}) {
  return (
    <div className="rounded-md border border-border p-2">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="inline-flex items-center gap-1 text-lg font-semibold tabular-nums">
        {value}
        {warn && <OverCapWarning />}
      </p>
    </div>
  );
}
