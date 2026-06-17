import { redis } from "@/lib/redis";
import { audit } from "@/server/security/audit";

/**
 * Emit a RATE_LIMIT_EXCEEDED audit event for a breached policy — but at most
 * ONCE per (policy, source) per 10 minutes, so a flood of blocked requests
 * (exactly when an attacker is hammering a limit) can't amplify into a flood of
 * audit-log writes. The Security tab still sees the breach; it just isn't
 * re-logged on every rejected attempt. Never throws.
 */
export async function auditRateLimitExceeded(opts: {
  policy: string;
  /** Dedup discriminator — the limiter key (ip / email). Used ephemerally in
   *  Redis only; never persisted (the audit row carries a salted ipHash). */
  source: string;
  actorUserId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  try {
    const first = await redis.set(
      `audit:rl:${opts.policy}:${opts.source}`,
      "1",
      "EX",
      600,
      "NX",
    );
    if (first !== "OK") return; // already logged for this source recently
  } catch {
    // Redis unavailable → fall through and log (better to over-log than miss).
  }
  await audit({
    event: "RATE_LIMIT_EXCEEDED",
    actorUserId: opts.actorUserId ?? null,
    subjectType: "policy",
    subjectId: opts.policy,
    ip: opts.ip,
    userAgent: opts.userAgent,
    metadata: { policy: opts.policy },
  });
}
