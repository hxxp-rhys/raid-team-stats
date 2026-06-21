import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/env";

/**
 * HMAC-SHA256 signed tokens for shareable raid-CALENDAR URLs. A deliberate
 * sibling of share-token.ts (dashboards), kept SEPARATE so the two never
 * entangle:
 *   - distinct version prefix ("c1." vs "v1.") → a calendar token can never be
 *     mistaken for (or replayed as) a dashboard token, and vice-versa;
 *   - self-contained verify → the public calendar procedures authorize purely
 *     from this module, never touching the dashboard share path or
 *     assertTeamReadAccess / the x-share-token header transport.
 *
 * Token format:  c1.<payload-b64url>.<signature-b64url>
 *   payload   = JSON.stringify({ r:raidTeamId, e?:expiresAtMs, v?:view })
 *   signature = HMAC-SHA256(SHARE_TOKEN_SECRET, "c1." + payload-b64url)
 *
 * Stateless (no DB row). Signing key = SHARE_TOKEN_SECRET (falls back to
 * AUTH_SECRET) — shared with dashboard shares, so a single rotation revokes
 * BOTH families at once. Per-team revocation: RaidTeam.calendarShareIsPublic
 * (+ link expiry), re-checked fresh on every resolve.
 *
 * TWO-MODE AUTHORIZATION (checked fresh every request, never cached):
 *  - calendarShareIsPublic=false (default): a valid token only ROUTES — the
 *    caller must still be a signed-in active member of the team.
 *  - calendarShareIsPublic=true: a valid token IS a read-only bearer
 *    capability for that team's calendar, pinned to its raidTeamId. It never
 *    authorizes a mutation. Flipping the flag off re-locks every link.
 */

const VERSION = "c1";
const MAX_TTL_DAYS = 366;

export type CalendarShareView = "agenda" | "month";

type Payload = {
  r: string; // raidTeamId
  e?: number; // expiresAt (ms). OMITTED = never expires.
  v?: CalendarShareView; // default view for the public page
};

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

const shareKey = env.SHARE_TOKEN_SECRET ?? env.AUTH_SECRET;

function sign(message: string): string {
  return b64urlEncode(createHmac("sha256", shareKey).update(message).digest());
}

export type CreateCalendarShareTokenInput = {
  raidTeamId: string;
  view: CalendarShareView;
  /** Lifetime in days. null/undefined = NEVER expires; positive clamped to [1,366]. */
  ttlDays?: number | null;
};

export function createCalendarShareToken(input: CreateCalendarShareTokenInput): {
  token: string;
  /** null when the link never expires. */
  expiresAt: Date | null;
} {
  const expiresAt =
    input.ttlDays == null
      ? null
      : new Date(
          Date.now() +
            Math.min(Math.max(1, Math.floor(input.ttlDays)), MAX_TTL_DAYS) *
              86_400_000,
        );
  const payload: Payload = {
    r: input.raidTeamId,
    ...(expiresAt ? { e: expiresAt.getTime() } : {}),
    v: input.view,
  };
  const payloadEnc = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const message = `${VERSION}.${payloadEnc}`;
  return { token: `${message}.${sign(message)}`, expiresAt };
}

export type VerifiedCalendarShareToken = {
  raidTeamId: string;
  view: CalendarShareView;
  /** null when the link never expires. */
  expiresAt: Date | null;
};

export function verifyCalendarShareToken(
  token: string,
): VerifiedCalendarShareToken | null {
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
    typeof (payload as Payload).r !== "string"
  ) {
    return null;
  }
  const p = payload as Payload;
  // Expiry OPTIONAL (omitted = never). When present, must be a future number.
  if (p.e !== undefined) {
    if (typeof p.e !== "number") return null;
    if (p.e < Date.now()) return null;
  }
  const view: CalendarShareView = p.v === "month" ? "month" : "agenda";
  return {
    raidTeamId: p.r,
    view,
    expiresAt: p.e !== undefined ? new Date(p.e) : null,
  };
}
