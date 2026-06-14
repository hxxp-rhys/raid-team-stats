import { randomBytes } from "node:crypto";

import type { ExtendedPrismaClient } from "@/lib/db";
import { audit } from "@/server/security/audit";

/**
 * Discord account-link via short-lived single-use codes (B3 — NOT share-token).
 * The website issues a code to a signed-in user; `/statsmith link code:<CODE>`
 * proves control of the Discord account (signed snowflake) and, if the code is
 * valid + unconsumed + unexpired, atomically burns it and writes the binding as
 * an `Account(provider="discord")` row (reuses @@unique([provider,
 * providerAccountId]) + the encrypted-token extension + getUserByAccount).
 */

const CODE_TTL_MS = 10 * 60_000; // 10 minutes
// Crockford base32 minus ambiguous chars — easy to read/type from the website.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i]! % 32];
  return out;
}

/** Issue a fresh link code for `userId`. Retries once on the ~1e-12 PK clash. */
export async function issueLinkCode(
  db: ExtendedPrismaClient,
  userId: string,
): Promise<{ code: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = generateCode();
    try {
      await db.discordLinkCode.create({ data: { code, userId, expiresAt } });
      return { code, expiresAt };
    } catch (err) {
      if (attempt === 1 || !isUniqueViolation(err)) throw err;
    }
  }
  // Unreachable (loop returns or throws), but satisfies the type checker.
  throw new Error("could not issue link code");
}

export type ConsumeResult =
  | { ok: true; userId: string; alreadyLinked: boolean }
  | { ok: false; reason: "invalid" | "expired" | "used" | "snowflake_taken" };

/**
 * Redeem a code for a Discord snowflake. Validates → checks the snowflake isn't
 * already bound to a DIFFERENT user → atomically burns the code → writes the
 * Account row. Returns a typed reason on any failure (for a friendly ephemeral).
 */
export async function consumeLinkCode(
  db: ExtendedPrismaClient,
  code: string,
  snowflake: string,
): Promise<ConsumeResult> {
  const normalized = code.trim().toUpperCase();
  const now = new Date();

  const row = await db.discordLinkCode.findUnique({
    where: { code: normalized },
    select: { userId: true, consumedAt: true, expiresAt: true },
  });
  if (!row) return { ok: false, reason: "invalid" };
  if (row.consumedAt) return { ok: false, reason: "used" };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };

  // Is this Discord account already bound? Idempotent for the same user; reject
  // a hijack onto a different account (unlink first to move it).
  const existing = await db.account.findUnique({
    where: { provider_providerAccountId: { provider: "discord", providerAccountId: snowflake } },
    select: { userId: true },
  });
  if (existing && existing.userId !== row.userId) {
    return { ok: false, reason: "snowflake_taken" };
  }

  // Atomic burn — guarded so a concurrent redeem can't double-consume.
  const burned = await db.discordLinkCode.updateMany({
    where: { code: normalized, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  if (burned.count === 0) return { ok: false, reason: "used" }; // raced

  if (existing) {
    // Already bound to this same user — idempotent success.
    return { ok: true, userId: row.userId, alreadyLinked: true };
  }

  try {
    await db.account.create({
      data: {
        userId: row.userId,
        type: "oauth",
        provider: "discord",
        providerAccountId: snowflake,
      },
    });
  } catch (err) {
    // Concurrent redeem of two codes for the same signed snowflake: the unique
    // (provider, providerAccountId) constraint is the authority. Re-read and
    // return idempotently rather than a confusing generic error on a burned code.
    if (isUniqueViolation(err)) {
      const now2 = await db.account.findUnique({
        where: { provider_providerAccountId: { provider: "discord", providerAccountId: snowflake } },
        select: { userId: true },
      });
      if (now2?.userId === row.userId) {
        return { ok: true, userId: row.userId, alreadyLinked: true };
      }
      return { ok: false, reason: "snowflake_taken" };
    }
    throw err;
  }
  await audit({
    event: "AUTH_DISCORD_LINKED",
    actorUserId: row.userId,
    subjectType: "user",
    subjectId: row.userId,
    metadata: { snowflake },
  });
  return { ok: true, userId: row.userId, alreadyLinked: false };
}

/** Discord snowflake → site user id (via the Account binding), or null. */
export async function resolveDiscordUserId(
  db: ExtendedPrismaClient,
  snowflake: string,
): Promise<string | null> {
  const acct = await db.account.findUnique({
    where: { provider_providerAccountId: { provider: "discord", providerAccountId: snowflake } },
    select: { userId: true },
  });
  return acct?.userId ?? null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}
