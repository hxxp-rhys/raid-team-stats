import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/env";

/**
 * HMAC-SHA256 signed tokens for shareable dashboard URLs.
 *
 * Token format:
 *   v1.<payload-b64url>.<signature-b64url>
 *
 *   payload    = JSON.stringify({d:dashboardId,e:expiresAtMs,r:raidTeamId})
 *   signature  = HMAC-SHA256(AUTH_SECRET, "v1." + payload-b64url)
 *
 * All bytes are base64url (no padding). Signature comparison is
 * timing-safe. Tokens are stateless — there's no database row — so
 * revoking a single share link means rotating AUTH_SECRET (which would
 * invalidate every existing token and signed session). Per-dashboard
 * revocation exists via DashboardConfig.shareIsPublic (and link expiry).
 *
 * TWO-MODE AUTHORIZATION (checked fresh on every request, never cached):
 *  - Dashboard PRIVATE (shareIsPublic=false, the default): a valid token
 *    is only a routing capability — the caller must still be a signed-in
 *    active member of the dashboard's team.
 *  - Dashboard PUBLIC (shareIsPublic=true): a valid token IS a bearer
 *    READ capability for that dashboard's team — assertTeamReadAccess
 *    accepts it (x-share-token header) for the read-only widget queries,
 *    pinned to exactly the token's raidTeamId. It never authorizes any
 *    mutation. Flipping shareIsPublic off re-locks every outstanding
 *    link at the next request.
 */

const VERSION = "v1";
const MAX_TTL_DAYS = 30;
const DEFAULT_TTL_DAYS = 7;

type Payload = {
  d: string; // dashboardId
  r: string; // raidTeamId (for the resolver's authorization fast-path)
  e: number; // expiresAt (ms since epoch)
  t?: string[]; // allowed tab ids (omitted = every tab is shared)
};

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function sign(message: string): string {
  return b64urlEncode(
    createHmac("sha256", env.AUTH_SECRET).update(message).digest(),
  );
}

export type CreateShareTokenInput = {
  dashboardId: string;
  raidTeamId: string;
  /** Defaults to 7 days. Clamped to MAX_TTL_DAYS. */
  ttlDays?: number;
  /**
   * If set, the link only exposes these dashboard tab ids. Omitted/empty =
   * every tab is shared (back-compat with tokens minted before this existed).
   */
  allowedTabIds?: string[];
};

export function createShareToken(input: CreateShareTokenInput): {
  token: string;
  expiresAt: Date;
} {
  const ttl = Math.min(Math.max(1, input.ttlDays ?? DEFAULT_TTL_DAYS), MAX_TTL_DAYS);
  const expiresAt = new Date(Date.now() + ttl * 24 * 60 * 60 * 1000);
  const payload: Payload = {
    d: input.dashboardId,
    r: input.raidTeamId,
    e: expiresAt.getTime(),
    ...(input.allowedTabIds && input.allowedTabIds.length > 0
      ? { t: input.allowedTabIds }
      : {}),
  };
  const payloadStr = JSON.stringify(payload);
  const payloadEnc = b64urlEncode(Buffer.from(payloadStr, "utf8"));
  const message = `${VERSION}.${payloadEnc}`;
  const sig = sign(message);
  return { token: `${message}.${sig}`, expiresAt };
}

export type VerifiedShareToken = {
  dashboardId: string;
  raidTeamId: string;
  expiresAt: Date;
  /** Allowed tab ids, or undefined when the link shares every tab. */
  allowedTabIds?: string[];
};

export function verifyShareToken(token: string): VerifiedShareToken | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, payloadEnc, sig] = parts;
  if (version !== VERSION || !payloadEnc || !sig) return null;

  const expectedSig = sign(`${version}.${payloadEnc}`);
  const a = b64urlDecode(sig);
  const b = b64urlDecode(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(payloadEnc).toString("utf8"));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as Payload).d !== "string" ||
    typeof (payload as Payload).r !== "string" ||
    typeof (payload as Payload).e !== "number"
  ) {
    return null;
  }
  const p = payload as Payload;
  if (p.e < Date.now()) return null;
  // `t` is optional; only honor it when it's an array of strings (old tokens
  // lack it → undefined → every tab is shared).
  const allowedTabIds =
    Array.isArray(p.t) && p.t.every((x) => typeof x === "string")
      ? p.t
      : undefined;
  return {
    dashboardId: p.d,
    raidTeamId: p.r,
    expiresAt: new Date(p.e),
    ...(allowedTabIds ? { allowedTabIds } : {}),
  };
}
