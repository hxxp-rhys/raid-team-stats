import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/env";

/**
 * HMAC-SHA256 signed tokens for shareable dashboard URLs.
 *
 * Token format:
 *   v1.<payload-b64url>.<signature-b64url>
 *
 *   payload    = JSON.stringify({d:dashboardId,e:expiresAtMs,r:raidTeamId})
 *   signature  = HMAC-SHA256(SHARE_TOKEN_SECRET, "v1." + payload-b64url)
 *
 * All bytes are base64url (no padding). Signature comparison is
 * timing-safe. Tokens are stateless — there's no database row. The signing
 * key is SHARE_TOKEN_SECRET (falling back to AUTH_SECRET when unset), kept
 * separate from AUTH_SECRET so that rotating it to revoke ALL outstanding
 * share links does NOT also invalidate every signed-in session. Per-dashboard
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
// The longest selectable expiry is one year; "never" omits the expiry claim
// entirely (the default). A positive ttlDays is clamped to this ceiling.
const MAX_TTL_DAYS = 366;

type Payload = {
  d: string; // dashboardId
  r: string; // raidTeamId (for the resolver's authorization fast-path)
  e?: number; // expiresAt (ms since epoch). OMITTED = never expires.
  t?: string[]; // allowed tab ids (omitted = every tab is shared)
};

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

// Dedicated key, decoupled from the session secret so share links can be
// revoked en masse (rotate SHARE_TOKEN_SECRET) without forcing a global logout.
const shareKey = env.SHARE_TOKEN_SECRET ?? env.AUTH_SECRET;

function sign(message: string): string {
  return b64urlEncode(createHmac("sha256", shareKey).update(message).digest());
}

export type CreateShareTokenInput = {
  dashboardId: string;
  raidTeamId: string;
  /**
   * Link lifetime in days. `null`/`undefined` = NEVER expires (the default).
   * A positive number is clamped to [1, MAX_TTL_DAYS] (one year).
   */
  ttlDays?: number | null;
  /**
   * If set, the link only exposes these dashboard tab ids. Omitted/empty =
   * every tab is shared (back-compat with tokens minted before this existed).
   */
  allowedTabIds?: string[];
};

export function createShareToken(input: CreateShareTokenInput): {
  token: string;
  /** null when the link never expires. */
  expiresAt: Date | null;
} {
  // null/undefined ttlDays → never expires (no `e` claim). A positive number
  // is clamped to [1, MAX_TTL_DAYS].
  const expiresAt =
    input.ttlDays == null
      ? null
      : new Date(
          Date.now() +
            Math.min(Math.max(1, Math.floor(input.ttlDays)), MAX_TTL_DAYS) *
              24 *
              60 *
              60 *
              1000,
        );
  const payload: Payload = {
    d: input.dashboardId,
    r: input.raidTeamId,
    ...(expiresAt ? { e: expiresAt.getTime() } : {}),
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
  /** null when the link never expires. */
  expiresAt: Date | null;
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
    typeof (payload as Payload).r !== "string"
  ) {
    return null;
  }
  const p = payload as Payload;
  // Expiry is OPTIONAL (omitted = never expires). When present it must be a
  // number and must still be in the future.
  if (p.e !== undefined) {
    if (typeof p.e !== "number") return null;
    if (p.e < Date.now()) return null;
  }
  // `t` is optional; only honor it when it's an array of strings (old tokens
  // lack it → undefined → every tab is shared).
  const allowedTabIds =
    Array.isArray(p.t) && p.t.every((x) => typeof x === "string")
      ? p.t
      : undefined;
  return {
    dashboardId: p.d,
    raidTeamId: p.r,
    expiresAt: p.e !== undefined ? new Date(p.e) : null,
    ...(allowedTabIds ? { allowedTabIds } : {}),
  };
}
