import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { AuditEvent } from "@/generated/prisma/enums";

type AuditInput = {
  event: AuditEvent;
  actorUserId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Prisma.InputJsonValue;
};

/**
 * Hash an IP with a daily salt so we can correlate same-day events from one IP
 * without ever storing the raw address. Salt rotates at UTC midnight to prevent
 * long-term cross-day correlation.
 */
const hashIp = (ip: string): string => {
  const day = new Date().toISOString().slice(0, 10);
  return createHash("sha256").update(`${day}:${ip}`).digest("hex").slice(0, 32);
};

/**
 * Append-only audit log writer. NEVER throws — audit failures are logged but
 * must not break the user-facing flow. Caller decides if a failure should
 * trigger separate alerting.
 */
export const audit = async (input: AuditInput): Promise<void> => {
  try {
    await db.auditLog.create({
      data: {
        event: input.event,
        actorUserId: input.actorUserId ?? null,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        ipHash: input.ip ? hashIp(input.ip) : null,
        userAgent: input.userAgent?.slice(0, 512) ?? null,
        metadata: input.metadata ?? undefined,
      },
    });
  } catch (err) {
    logger.error({ err, event: input.event }, "audit log write failed");
  }
};
