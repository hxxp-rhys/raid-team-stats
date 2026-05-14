/**
 * k6 load test for the public auth surface and roster-refresh rate limit.
 *
 * Run locally (k6 installed: https://k6.io/docs/get-started/installation/):
 *   k6 run tests/load/k6-auth.js
 *
 * Override target / pacing:
 *   k6 run --env BASE_URL=https://staging.example.com \
 *          --vus 25 --duration 1m tests/load/k6-auth.js
 *
 * Thresholds: anything red is a regression in the rate-limit middleware or
 * the cold start of the env validator on /api/health.
 */

import http from "k6/http";
import { check, group, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:3000";

export const options = {
  scenarios: {
    smoke: {
      executor: "constant-vus",
      vus: 10,
      duration: __ENV.DURATION || "30s",
      gracefulStop: "5s",
    },
  },
  thresholds: {
    // p95 under 300ms on /api/health is generous for local; tune for prod.
    "http_req_duration{name:health}": ["p(95)<300"],
    "http_req_duration{name:signin_page}": ["p(95)<800"],
    "http_req_failed": ["rate<0.01"],
  },
};

// k6's runtime invokes the default export per VU iteration — the anonymous
// shape is canonical for the tool, not a code-style issue.
// eslint-disable-next-line import/no-anonymous-default-export
export default function () {
  group("liveness", () => {
    const res = http.get(`${BASE}/api/health`, { tags: { name: "health" } });
    check(res, { "200": (r) => r.status === 200 });
  });

  group("public pages", () => {
    const signin = http.get(`${BASE}/signin`, { tags: { name: "signin_page" } });
    check(signin, {
      "200": (r) => r.status === 200,
      "CSP set": (r) =>
        String(r.headers["Content-Security-Policy"] ?? "").includes("default-src 'self'"),
    });
  });

  // Tight loop — the request-level rate limiter should keep this user under
  // its window without ever returning 5xx.
  group("rate-limit burst (expect some 429)", () => {
    for (let i = 0; i < 5; i++) {
      const res = http.get(`${BASE}/signin`, { tags: { name: "burst_signin" } });
      check(res, { "no 5xx": (r) => r.status < 500 });
    }
  });

  sleep(1);
}
