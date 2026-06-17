import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { router, protectedProcedure, isPlatformAdmin } from "@/server/api/trpc";
import {
  promScalar,
  promVector,
  promRange,
  lokiCount,
  lokiLogs,
} from "@/server/monitoring/client";

/**
 * Platform-admin-only observability surface for the in-app Monitoring page.
 * Queries Prometheus + Loki server-side (defense in depth: the /admin layout
 * gates the page, and every procedure re-checks admin). This is the in-website
 * equivalent of the Grafana dashboards, reachable through normal auth — so a
 * cloud-hosted instance never has to expose Grafana publicly.
 */

async function assertAdmin(userId: string): Promise<void> {
  if (!(await isPlatformAdmin(userId))) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

const JOB = `job="raid-team-stats-web"`;
const CADDY = `{container="rts-caddy"}`;

export const monitoringRouter = router({
  /** Current-state snapshot: web runtime health + HTTP summary + auth events. */
  snapshot: protectedProcedure.query(async ({ ctx }) => {
    await assertAdmin(ctx.session.user.id);
    const [
      up,
      startTime,
      cpuRate,
      rss,
      heapUsed,
      heapTotal,
      openFds,
      maxFds,
      lagP99,
      reqs1h,
      err5xx1h,
      err4xx1h,
      authEvents,
    ] = await Promise.all([
      promScalar(`up{${JOB}}`),
      promScalar(`rts_process_start_time_seconds{${JOB}}`),
      promScalar(`rate(rts_process_cpu_seconds_total{${JOB}}[5m])`),
      promScalar(`rts_process_resident_memory_bytes{${JOB}}`),
      promScalar(`rts_nodejs_heap_size_used_bytes{${JOB}}`),
      promScalar(`rts_nodejs_heap_size_total_bytes{${JOB}}`),
      promScalar(`rts_process_open_fds{${JOB}}`),
      promScalar(`rts_process_max_fds{${JOB}}`),
      promScalar(`rts_nodejs_eventloop_lag_p99_seconds{${JOB}}`),
      lokiCount(`sum(count_over_time(${CADDY}[1h]))`, 3600),
      lokiCount(`sum(count_over_time(${CADDY} | json | status >= 500 [1h]))`, 3600),
      lokiCount(`sum(count_over_time(${CADDY} | json | status >= 400 | status < 500 [1h]))`, 3600),
      promVector(`sum by (event) (increase(rts_auth_events_total{${JOB}}[24h]))`),
    ]);

    return {
      reachable: up != null, // could we even reach Prometheus?
      up: up === 1,
      uptimeSec: startTime != null ? Math.max(0, Date.now() / 1000 - startTime) : null,
      cpuPct: cpuRate != null ? cpuRate * 100 : null,
      rssBytes: rss,
      heapUsedBytes: heapUsed,
      heapTotalBytes: heapTotal,
      openFds,
      maxFds,
      eventLoopLagP99Ms: lagP99 != null ? lagP99 * 1000 : null,
      http1h: { requests: reqs1h, serverErrors: err5xx1h, clientErrors: err4xx1h },
      authEvents24h: authEvents.map((a) => ({ event: a.labels.event ?? "?", count: a.value })),
    };
  }),

  /** Time series for the charts: CPU% and resident memory over a window. */
  series: protectedProcedure
    .input(z.object({ hours: z.number().int().min(1).max(48).default(6) }))
    .query(async ({ ctx, input }) => {
      await assertAdmin(ctx.session.user.id);
      const end = Math.floor(Date.now() / 1000);
      const start = end - input.hours * 3600;
      const step = Math.max(30, Math.floor((end - start) / 200));
      const [cpu, rss] = await Promise.all([
        promRange(`rate(rts_process_cpu_seconds_total{${JOB}}[5m]) * 100`, start, end, step),
        promRange(`rts_process_resident_memory_bytes{${JOB}}`, start, end, step),
      ]);
      return { cpu, rss };
    }),

  /**
   * WCL worldData persistence health: the auto-resolved live raid tier + the
   * snapshot's freshness, so an admin can see at a glance that the self-updating
   * zone resolution is working (and whether a manual env pin is overriding /
   * drifting from it).
   */
  raidTier: protectedProcedure.query(async ({ ctx }) => {
    await assertAdmin(ctx.session.user.id);
    const [currents, agg, raidCount] = await Promise.all([
      ctx.db.wclZone.findMany({
        where: { isCurrentRaid: true },
        orderBy: { id: "asc" },
        select: {
          id: true,
          name: true,
          expansionName: true,
          encounters: true,
          refreshedAt: true,
        },
      }),
      ctx.db.wclZone.aggregate({ _count: true, _max: { refreshedAt: true } }),
      ctx.db.wclZone.count({ where: { isRaid: true } }),
    ]);
    const envPinRaw = process.env.WCL_RAID_ZONE_ID;
    const envPin =
      envPinRaw && Number.isFinite(Number(envPinRaw)) ? Number(envPinRaw) : null;
    // The whole current RELEASE's raid set (patches add raids, so usually >1).
    const currentRaids = currents.map((c) => ({
      zoneId: c.id,
      name: c.name,
      expansion: c.expansionName ?? null,
      bossCount: Array.isArray(c.encounters) ? c.encounters.length : 0,
    }));
    const trackedIds = currentRaids.map((c) => c.zoneId);
    return {
      currentRaids,
      bossTotal: currentRaids.reduce((s, c) => s + c.bossCount, 0),
      totalZones: agg._count,
      raidZones: raidCount,
      lastRefreshedAt: agg._max.refreshedAt,
      envPin,
      // Pin set AND it isn't EXACTLY the auto-resolved set → the pin forces a
      // single zone and hides current raids (and may be stale). Worker logs it.
      envPinStale:
        envPin != null && (trackedIds.length !== 1 || trackedIds[0] !== envPin),
    };
  }),

  /** Recent error/fatal log lines + the structured audit feed. */
  activity: protectedProcedure
    .input(z.object({ errorLimit: z.number().int().min(1).max(100).default(25), auditLimit: z.number().int().min(1).max(100).default(25) }))
    .query(async ({ ctx, input }) => {
      await assertAdmin(ctx.session.user.id);
      const [errors, audit] = await Promise.all([
        lokiLogs(
          `{container=~"rts-web|rts-worker"} |~ \`(?i)(error|fatal)\``,
          input.errorLimit,
        ),
        ctx.db.auditLog.findMany({
          orderBy: { createdAt: "desc" },
          take: input.auditLimit,
          select: {
            id: true,
            event: true,
            actorUserId: true,
            subjectType: true,
            createdAt: true,
            actor: { select: { displayName: true } },
          },
        }),
      ]);
      return {
        errors,
        audit: audit.map((a) => ({
          id: String(a.id),
          event: a.event,
          actor: a.actor?.displayName ?? a.actorUserId ?? "system",
          subjectType: a.subjectType,
          createdAt: a.createdAt,
        })),
      };
    }),
});
