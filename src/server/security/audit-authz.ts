import type { Prisma } from "@/generated/prisma/client";
import { redis } from "@/lib/redis";
import { audit } from "@/server/security/audit";

/**
 * Emit an AUTHZ_DENIED audit event for a denied guild/team access — deduped per
 * (actor, scope, resource) for 5 minutes, so a client repeatedly hammering the
 * SAME forbidden resource (a buggy retry, or probing) can't flood the audit log.
 * Distinct resources are still each logged (so privilege-probing breadth is
 * visible), and the per-user mutation rate limit caps the overall rate. Never
 * throws.
 */
export async function auditAuthzDenied(opts: {
  actorUserId: string;
  scope: "guild" | "raidTeam";
  subjectId: string;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Prisma.InputJsonValue;
}): Promise<void> {
  try {
    const first = await redis.set(
      `audit:authz:${opts.actorUserId}:${opts.scope}:${opts.subjectId}`,
      "1",
      "EX",
      300,
      "NX",
    );
    if (first !== "OK") return; // same actor+resource logged recently
  } catch {
    // Redis unavailable → fall through and log (better to over-log than miss).
  }
  await audit({
    event: "AUTHZ_DENIED",
    actorUserId: opts.actorUserId,
    subjectType: opts.scope,
    subjectId: opts.subjectId,
    ip: opts.ip,
    userAgent: opts.userAgent,
    metadata: opts.metadata,
  });
}
