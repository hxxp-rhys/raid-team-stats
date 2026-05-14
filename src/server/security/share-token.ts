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
 * invalidate every existing token and signed session). For per-link
 * revocation we'd add a tokens table; for v1, stateless is the right
 * trade-off because share links are short-lived and the visibility
 * permission is enforced at resolve time (guild membership check).
 *
 * Crucially: a valid token alone does NOT grant access. The resolver
 * still asserts the caller is an active guild member of the dashboard's
 * raid team's guild. Tokens are a *capability hint* for the URL, not a
 * bypass of authorization.
 */

const VERSION = "v1";
const MAX_TTL_DAYS = 30;
const DEFAULT_TTL_DAYS = 7;

type Payload = {
  d: string; // dashboardId
  r: string; // raidTeamId (for the resolver's authorization fast-path)
  e: number; // expiresAt (ms since epoch)
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
  return { dashboardId: p.d, raidTeamId: p.r, expiresAt: new Date(p.e) };
}
