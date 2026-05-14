import { NextResponse, type NextRequest } from "next/server";
import { newCspNonce, CSP_NONCE_HEADER, buildCsp } from "@/server/security/csp";
import { applySecurityHeaders } from "@/server/security/headers";
import { consumeLimit, policies, ipKey } from "@/server/security/rate-limit";
import { env } from "@/env";

const PROXY_HEADER_NAMES = [
  "x-forwarded-for",
  "cf-connecting-ip",
  "true-client-ip",
  "x-real-ip",
] as const;

const isProxyHeader = (name: string): boolean =>
  (PROXY_HEADER_NAMES as readonly string[]).includes(name.toLowerCase());

/**
 * Strips client-supplied proxy headers when RATE_LIMIT_TRUST_PROXY is false.
 * Prevents header-spoofing rate-limit bypass when running without a vetted
 * reverse proxy in front of the app.
 */
const sanitizeProxyHeaders = (request: NextRequest, headers: Headers) => {
  if (env.RATE_LIMIT_TRUST_PROXY) return;
  for (const name of request.headers.keys()) {
    if (isProxyHeader(name)) headers.delete(name);
  }
};

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const nonce = newCspNonce();
  const isDev = env.NODE_ENV !== "production";
  const isHttps =
    request.nextUrl.protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https";

  const rl = await consumeLimit(policies.globalIp, ipKey(request));
  if (!rl.allowed) {
    const denied = new NextResponse("Too Many Requests", {
      status: 429,
      headers: {
        "Retry-After": Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000)).toString(),
        "RateLimit-Limit": rl.limit.toString(),
        "RateLimit-Remaining": "0",
        "RateLimit-Reset": Math.ceil(rl.resetAt / 1000).toString(),
      },
    });
    return applySecurityHeaders({ response: denied, nonce, isDev, isHttps });
  }

  const forwardedHeaders = new Headers(request.headers);
  sanitizeProxyHeaders(request, forwardedHeaders);
  forwardedHeaders.set(CSP_NONCE_HEADER, nonce);
  // Next 16 reads the Content-Security-Policy off the *request* headers to
  // extract the nonce it tags onto its own bundle <script> tags. Without
  // this, static prerender emits unnonced scripts that 'strict-dynamic'
  // then blocks — hydration never happens and the page looks empty.
  forwardedHeaders.set("Content-Security-Policy", buildCsp({ nonce, isDev }));

  const response = NextResponse.next({ request: { headers: forwardedHeaders } });

  response.headers.set("RateLimit-Limit", rl.limit.toString());
  response.headers.set("RateLimit-Remaining", rl.remaining.toString());
  response.headers.set("RateLimit-Reset", Math.ceil(rl.resetAt / 1000).toString());

  return applySecurityHeaders({ response, nonce, isDev, isHttps });
}

export const config = {
  matcher: [
    // Match everything except Next's internals, static assets, and the well-known
    // health/ready endpoints (which must respond fast and not consume rate budget).
    "/((?!_next/static|_next/image|favicon.ico|api/health|api/ready).*)",
  ],
};
