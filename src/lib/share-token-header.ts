"use client";

/**
 * Module-level holder for the dashboard share token. The /share/[token]
 * page sets it during render (idempotent write, cleared on unmount) and
 * the tRPC client attaches it as the `x-share-token` header on every
 * request — which is how an anonymous public-share viewer's widget queries
 * authorize (assertTeamReadAccess grants READ-ONLY access to exactly the
 * token's team, and only while its dashboard is flagged public).
 */
let current: string | null = null;

export function setShareTokenHeader(token: string | null): void {
  current = token;
}

export function getShareTokenHeader(): string | null {
  return current;
}
