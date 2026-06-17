"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const REFRESH_MS = 30_000;

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function fmtUptime(s: number | null | undefined): string {
  if (s == null) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return n >= 1000 ? Math.round(n).toLocaleString() : String(Math.round(n));
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border-border rounded-lg border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-muted-foreground text-[10px]">{sub}</div>}
    </div>
  );
}

/** Compact auto-scaling SVG area chart for a time series of [tsSec, value]. */
function MiniChart({
  points,
  color,
  format,
}: {
  points: Array<[number, number]>;
  color: string;
  format: (n: number) => string;
}) {
  if (points.length < 2) {
    return (
      <div className="text-muted-foreground flex h-24 items-center justify-center text-xs">
        No data in range
      </div>
    );
  }
  const W = 600;
  const H = 96;
  const PAD = 4;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys) * 1.1 || 1;
  const x = (t: number) => PAD + ((t - minX) / (maxX - minX || 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - (v / maxY) * (H - 2 * PAD);
  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(maxX).toFixed(1)},${H - PAD} L${x(minX).toFixed(1)},${H - PAD} Z`;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full" preserveAspectRatio="none">
        <path d={area} fill={color} opacity={0.12} />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="text-muted-foreground mt-1 flex justify-between text-[10px] tabular-nums">
        <span>now {format(ys[ys.length - 1]!)}</span>
        <span>peak {format(Math.max(...ys))}</span>
      </div>
    </div>
  );
}

export default function MonitoringPage() {
  const [hours, setHours] = useState(6);
  const snap = api.monitoring.snapshot.useQuery(undefined, { refetchInterval: REFRESH_MS });
  const series = api.monitoring.series.useQuery({ hours }, { refetchInterval: REFRESH_MS });
  const activity = api.monitoring.activity.useQuery({}, { refetchInterval: REFRESH_MS });
  const raidTier = api.monitoring.raidTier.useQuery(undefined, {
    refetchInterval: REFRESH_MS,
  });
  const s = snap.data;
  const rt = raidTier.data;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Monitoring</h2>
        <p className="text-muted-foreground text-sm">
          Live system health, traffic, and recent activity — read from Prometheus
          + Loki through your admin session, so it works on any host without
          exposing Grafana. Auto-refreshes every 30s.
        </p>
      </div>

      {s && !s.reachable && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
          Couldn&apos;t reach Prometheus at the configured URL. The metrics stack
          may be down, or <code className="bg-muted/50 rounded px-1">PROMETHEUS_URL</code>{" "}
          / <code className="bg-muted/50 rounded px-1">LOKI_URL</code> need setting.
        </p>
      )}

      {/* Runtime health */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Web service</CardTitle>
          <CardDescription>
            {snap.isPending
              ? "Loading…"
              : s?.up
                ? "Up and serving"
                : !s?.reachable
                  ? "Prometheus unreachable — check PROMETHEUS_URL / the prometheus container"
                  : "Prometheus can't scrape the web /api/metrics — usually a METRICS_TOKEN mismatch (recreate the prometheus container after a token/.env change), not the web container itself"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Status"
              value={s?.up ? "● Up" : snap.isPending ? "…" : "● Down"}
            />
            <Stat label="Uptime" value={fmtUptime(s?.uptimeSec)} />
            <Stat label="CPU" value={s?.cpuPct != null ? `${s.cpuPct.toFixed(0)}%` : "—"} />
            <Stat
              label="Memory (RSS)"
              value={fmtBytes(s?.rssBytes)}
              sub={`heap ${fmtBytes(s?.heapUsedBytes)} / ${fmtBytes(s?.heapTotalBytes)}`}
            />
            <Stat
              label="Event-loop lag p99"
              value={s?.eventLoopLagP99Ms != null ? `${s.eventLoopLagP99Ms.toFixed(0)} ms` : "—"}
            />
            <Stat
              label="File descriptors"
              value={s?.openFds != null ? fmtNum(s.openFds) : "—"}
              sub={s?.maxFds != null ? `of ${fmtNum(s.maxFds)} max` : undefined}
            />
            <Stat label="Requests (1h)" value={fmtNum(s?.http1h.requests)} />
            <Stat
              label="HTTP errors (1h)"
              value={fmtNum(s?.http1h.serverErrors)}
              sub={`${fmtNum(s?.http1h.clientErrors)} client (4xx)`}
            />
          </div>
        </CardContent>
      </Card>

      {/* Charts */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Resource usage</CardTitle>
            <CardDescription>CPU and memory over time.</CardDescription>
          </div>
          <div className="flex gap-1">
            {[6, 12, 24].map((h) => (
              <button
                key={h}
                onClick={() => setHours(h)}
                className={`rounded-md border px-2 py-1 text-xs ${
                  hours === h ? "border-primary text-primary" : "border-border text-muted-foreground"
                }`}
              >
                {h}h
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="grid gap-6 sm:grid-cols-2">
          <div>
            <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">CPU %</div>
            <MiniChart
              points={series.data?.cpu ?? []}
              color="#6ea8fe"
              format={(n) => `${n.toFixed(0)}%`}
            />
          </div>
          <div>
            <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
              Memory (RSS)
            </div>
            <MiniChart points={series.data?.rss ?? []} color="#5fd0a0" format={fmtBytes} />
          </div>
        </CardContent>
      </Card>

      {/* Auth events */}
      {s && s.authEvents24h.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Auth events (24h)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2 text-sm">
              {s.authEvents24h.map((a) => (
                <span key={a.event} className="border-border rounded-md border px-2 py-1">
                  {a.event.replace(/_/g, " ")}:{" "}
                  <span className="font-semibold tabular-nums">{fmtNum(a.count)}</span>
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* WCL raid tier (self-updating worldData snapshot) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">WCL raid tier</CardTitle>
          <CardDescription>
            Auto-resolved from the persisted worldData snapshot (refreshed on the
            worker every 6h) — no manual zone pin needed per patch.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {raidTier.isPending ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : !rt?.currentRaids.length ? (
            <p className="text-muted-foreground text-sm">
              No worldData snapshot yet — the worker populates it on boot + every
              6h.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat
                  label={`Current raids (${rt.currentRaids.length})`}
                  value={rt.currentRaids.map((c) => c.name).join(" · ")}
                  sub={`zones ${rt.currentRaids.map((c) => c.zoneId).join(", ")}${rt.currentRaids[0]?.expansion ? ` · ${rt.currentRaids[0].expansion}` : ""}`}
                />
                <Stat label="Bosses (release)" value={fmtNum(rt.bossTotal)} />
                <Stat
                  label="Zones tracked"
                  value={fmtNum(rt.totalZones)}
                  sub={`${fmtNum(rt.raidZones)} raids`}
                />
                <Stat
                  label="Snapshot refreshed"
                  value={
                    rt.lastRefreshedAt
                      ? new Date(rt.lastRefreshedAt).toLocaleString()
                      : "—"
                  }
                />
              </div>
              {rt.envPin != null && (
                <p
                  className={
                    rt.envPinStale
                      ? "rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground text-xs"
                  }
                >
                  {rt.envPinStale ? (
                    <>
                      ⚠ <code className="bg-muted/50 rounded px-1">WCL_RAID_ZONE_ID</code>{" "}
                      is pinned to <strong>{rt.envPin}</strong>, which forces a
                      single zone and hides the rest of the live release (
                      {rt.currentRaids.map((c) => c.zoneId).join(", ")}). Unset it
                      to track the full release.
                    </>
                  ) : (
                    <>
                      Manual override{" "}
                      <code className="bg-muted/50 rounded px-1">WCL_RAID_ZONE_ID={rt.envPin}</code>{" "}
                      is set. It can be safely unset to let the release auto-resolve.
                    </>
                  )}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Activity feeds */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent errors</CardTitle>
            <CardDescription>Error/fatal log lines from web + worker.</CardDescription>
          </CardHeader>
          <CardContent>
            {activity.isPending ? (
              <p className="text-muted-foreground text-sm">Loading…</p>
            ) : (activity.data?.errors.length ?? 0) === 0 ? (
              <p className="text-muted-foreground text-sm">None recently. 🎉</p>
            ) : (
              <ul className="space-y-2">
                {activity.data!.errors.map((e, i) => (
                  <li key={i} className="border-border/60 border-l-2 pl-2">
                    <div className="text-muted-foreground text-[10px] tabular-nums">
                      {new Date(e.tsMs).toLocaleString()} · {e.container}
                    </div>
                    <div className="break-words font-mono text-xs">{e.line.slice(0, 300)}</div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent activity</CardTitle>
            <CardDescription>Audit log — privileged + security events.</CardDescription>
          </CardHeader>
          <CardContent>
            {activity.isPending ? (
              <p className="text-muted-foreground text-sm">Loading…</p>
            ) : (activity.data?.audit.length ?? 0) === 0 ? (
              <p className="text-muted-foreground text-sm">No audit events yet.</p>
            ) : (
              <ul className="divide-border divide-y text-sm">
                {activity.data!.audit.map((a) => (
                  <li key={a.id} className="flex items-baseline justify-between gap-3 py-1.5">
                    <span className="min-w-0">
                      <span className="font-medium">{a.event.replace(/_/g, " ").toLowerCase()}</span>
                      <span className="text-muted-foreground block text-xs">
                        {a.actor}
                        {a.subjectType ? ` · ${a.subjectType}` : ""}
                      </span>
                    </span>
                    <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                      {new Date(a.createdAt).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
