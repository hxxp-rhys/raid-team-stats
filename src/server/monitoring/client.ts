import { env } from "@/env";
import { logger } from "@/lib/logger";

/**
 * Thin, defensive client for querying Prometheus + Loki HTTP APIs server-side.
 * Used by the admin Monitoring page so cloud hosts get observability through
 * the website's own admin auth (no need to expose Grafana). These internal
 * APIs are unauthenticated on the compose network; the page that calls them is
 * platform-admin-gated. Every helper swallows errors → null/[]: a monitoring
 * panel must never take down the request.
 */

const TIMEOUT_MS = 8000;

// Strip ANSI color codes (pretty-printed dev logs) for readable error feeds.
// Built from a char code so there's no control char / escaping in source.
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

type PromResult = {
  metric?: Record<string, string>;
  value?: [number, string];
  values?: Array<[number, string]>;
};
type PromResponse = { data?: { result?: PromResult[] } };
type LokiStream = { stream?: Record<string, string>; values?: Array<[string, string]> };
type LokiResponse = { data?: { result?: LokiStream[] } };

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err, url: url.split("?")[0] }, "monitoring query failed");
    return null;
  }
}

const promUrl = (p: string) => `${env.PROMETHEUS_URL}/api/v1/${p}`;
const lokiUrl = (p: string) => `${env.LOKI_URL}/loki/api/v1/${p}`;
const nowNs = () => `${Date.now()}000000`;
const agoNs = (sec: number) => `${Date.now() - sec * 1000}000000`;

/** First scalar value of an instant PromQL query, or null. */
export async function promScalar(query: string): Promise<number | null> {
  const j = await getJson<PromResponse>(promUrl(`query?query=${encodeURIComponent(query)}`));
  const first = j?.data?.result?.[0]?.value?.[1];
  const v = first != null ? Number(first) : NaN;
  return Number.isFinite(v) ? v : null;
}

/** Instant vector → [{ labels, value }] (e.g. a counter broken down by label). */
export async function promVector(
  query: string,
): Promise<Array<{ labels: Record<string, string>; value: number }>> {
  const j = await getJson<PromResponse>(promUrl(`query?query=${encodeURIComponent(query)}`));
  return (j?.data?.result ?? [])
    .map((r) => ({ labels: r.metric ?? {}, value: Number(r.value?.[1]) }))
    .filter((x) => Number.isFinite(x.value));
}

/** Range query → [tsSeconds, value][] for the first series. */
export async function promRange(
  query: string,
  startSec: number,
  endSec: number,
  stepSec: number,
): Promise<Array<[number, number]>> {
  const j = await getJson<PromResponse>(
    promUrl(
      `query_range?query=${encodeURIComponent(query)}&start=${startSec}&end=${endSec}&step=${stepSec}`,
    ),
  );
  return (j?.data?.result?.[0]?.values ?? [])
    .map((p) => [Number(p[0]), Number(p[1])] as [number, number])
    .filter((p) => Number.isFinite(p[1]));
}

/** Sum the latest value of a Loki metric query over `sinceSec` (e.g. log counts). */
export async function lokiCount(query: string, sinceSec = 3600): Promise<number> {
  const j = await getJson<PromResponse>(
    lokiUrl(
      `query_range?query=${encodeURIComponent(query)}&start=${agoNs(sinceSec)}&end=${nowNs()}&step=${sinceSec}`,
    ),
  );
  let total = 0;
  for (const s of j?.data?.result ?? []) {
    const vals = s.values;
    if (Array.isArray(vals) && vals.length) total += Number(vals[vals.length - 1][1]) || 0;
  }
  return total;
}

/** Recent Loki log lines (newest first) → [{ tsMs, container, line }]. */
export async function lokiLogs(
  query: string,
  limit = 30,
  sinceSec = 6 * 3600,
): Promise<Array<{ tsMs: number; container: string; line: string }>> {
  const j = await getJson<LokiResponse>(
    lokiUrl(
      `query_range?query=${encodeURIComponent(query)}&start=${agoNs(sinceSec)}&end=${nowNs()}&limit=${limit}&direction=backward`,
    ),
  );
  const out: Array<{ tsMs: number; container: string; line: string }> = [];
  for (const s of j?.data?.result ?? []) {
    const container = s.stream?.container ?? s.stream?.service_name ?? "?";
    for (const v of s.values ?? []) {
      out.push({
        tsMs: Math.floor(Number(v[0]) / 1e6),
        container,
        line: String(v[1]).replace(ANSI, ""),
      });
    }
  }
  return out.sort((a, b) => b.tsMs - a.tsMs).slice(0, limit);
}
