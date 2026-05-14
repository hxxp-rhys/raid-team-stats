import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/**
 * Single global Prometheus registry. All instrumentation in the app
 * registers here; the /api/metrics endpoint serialises it.
 *
 * Default Node metrics (event loop lag, GC pause, heap, etc.) are turned
 * on so we get baseline runtime health without writing per-metric code.
 *
 * Prefix all custom metrics with `rts_` so they don't collide with anything
 * Prometheus may scrape from a future sidecar.
 */
export const registry = new Registry();

const ensureDefaults = (() => {
  let initialised = false;
  return () => {
    if (initialised) return;
    initialised = true;
    collectDefaultMetrics({ register: registry, prefix: "rts_" });
  };
})();
ensureDefaults();

// ─── HTTP ──────────────────────────────────────────────────────────────────

export const httpRequestDuration = new Histogram({
  name: "rts_http_request_duration_seconds",
  help: "End-to-end HTTP request duration as measured by the proxy",
  labelNames: ["method", "route_class", "status_class"] as const,
  // Buckets tuned for a typical Next.js app: 5ms fastest, 5s slowest.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpRateLimited = new Counter({
  name: "rts_http_rate_limited_total",
  help: "Requests rejected by the per-IP global rate limit at the proxy",
  registers: [registry],
});

// ─── Auth ──────────────────────────────────────────────────────────────────

export const authEventsTotal = new Counter({
  name: "rts_auth_events_total",
  help: "Auth-relevant events emitted by the credentials provider",
  labelNames: ["event"] as const, // login_success | login_failure | mfa_required | mfa_failure
  registers: [registry],
});

// ─── BullMQ ────────────────────────────────────────────────────────────────

export const jobsTotal = new Counter({
  name: "rts_jobs_total",
  help: "BullMQ jobs by queue + terminal status",
  labelNames: ["queue", "status"] as const, // completed | failed
  registers: [registry],
});

export const jobDurationSeconds = new Histogram({
  name: "rts_job_duration_seconds",
  help: "BullMQ job execution time per queue",
  labelNames: ["queue"] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: "rts_queue_depth",
  help: "Current waiting + delayed job count per queue",
  labelNames: ["queue", "state"] as const,
  registers: [registry],
});

// ─── Ingestion ─────────────────────────────────────────────────────────────

export const upstreamRequestsTotal = new Counter({
  name: "rts_upstream_requests_total",
  help: "Outbound HTTP requests to ingestion sources, by status class",
  labelNames: ["source", "status_class"] as const, // source: blizzard | wcl | raiderio | wowaudit
  registers: [registry],
});

export const upstreamBudgetRemaining = new Gauge({
  name: "rts_upstream_budget_remaining",
  help: "Estimated tokens remaining in each upstream bucket",
  labelNames: ["source"] as const,
  registers: [registry],
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Classify a status code into "2xx" | "3xx" | "4xx" | "5xx" | "other". */
export const statusClass = (status: number): string => {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "other";
};

/**
 * Buckets a pathname into a small set of "route classes" so we don't blow
 * up the metric cardinality on every dashboard ID.
 */
export const routeClass = (pathname: string): string => {
  if (pathname.startsWith("/api/auth")) return "auth";
  if (pathname.startsWith("/api/trpc")) return "trpc";
  if (pathname.startsWith("/api/health")) return "health";
  if (pathname.startsWith("/api/ready")) return "ready";
  if (pathname.startsWith("/api/metrics")) return "metrics";
  if (pathname.startsWith("/api")) return "api_other";
  if (pathname.startsWith("/share")) return "share";
  if (pathname.startsWith("/guild/") && pathname.includes("/dashboard")) return "dashboard";
  if (pathname.startsWith("/guild")) return "guild";
  if (pathname === "/" || pathname === "") return "home";
  if (pathname.startsWith("/admin")) return "admin";
  if (pathname.startsWith("/profile")) return "profile";
  if (pathname.startsWith("/signin") || pathname.startsWith("/signup")) return "auth_page";
  return "other";
};
