import type { NextRequest } from "next/server";
import { handlers } from "@/server/auth";

/**
 * Battle.net OAuth callback. We register this URL with the Battle.net
 * developer console (env: BATTLENET_REDIRECT_URI) and proxy each request
 * into Auth.js's standard catch-all callback handler.
 *
 * The proxy preserves query params (code, state) and cookies (PKCE verifier,
 * Auth.js state) so the downstream handler sees the request as if Battle.net
 * had called `/api/auth/callback/battlenet` directly.
 */

const rewriteToAuthjs = (request: NextRequest): Request => {
  const original = new URL(request.url);
  const rewritten = new URL("/api/auth/callback/battlenet", original.origin);
  rewritten.search = original.search;
  return new Request(rewritten.toString(), {
    method: request.method,
    headers: request.headers,
    body:
      request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
    // `duplex` is required when forwarding a streaming body; safe to set on
    // GETs where body is undefined.
    duplex: "half",
  } as RequestInit);
};

export async function GET(request: NextRequest) {
  return handlers.GET(rewriteToAuthjs(request) as unknown as NextRequest);
}

export async function POST(request: NextRequest) {
  return handlers.POST(rewriteToAuthjs(request) as unknown as NextRequest);
}
