import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { env } from "@/env";

/**
 * Single-use, time-limited tokens for email verification and password reset.
 *
 * Storage: the database holds only a SHA-256 hash of the token, so a leaked
 * `VerificationToken` row cannot be replayed to verify or reset an account.
 * Comparison uses constant-time `timingSafeEqual`.
 *
 * Length: 32 random bytes encoded base64url — 256 bits of entropy, well above
 * the brute-force-via-network threshold for any realistic TTL.
 */

const TOKEN_BYTE_LEN = 32;
const TTL_VERIFY_MS = 24 * 60 * 60 * 1000; // 24h
const TTL_RESET_MS = 60 * 60 * 1000; // 1h

type TokenKind = "verify_email" | "password_reset";

const identifier = (kind: TokenKind, userId: string): string => `${kind}:${userId}`;

const hash = (raw: string): string => createHash("sha256").update(raw).digest("hex");

export type IssuedToken = {
  raw: string; // sent to the user via email
  expiresAt: Date;
};

const ttlFor = (kind: TokenKind): number =>
  kind === "verify_email" ? TTL_VERIFY_MS : TTL_RESET_MS;

/**
 * Issues a fresh token and stores its hash. Any existing token for the same
 * (kind, userId) is invalidated, so a second reset request supersedes the
 * first.
 */
export const issueToken = async (
  kind: TokenKind,
  userId: string,
): Promise<IssuedToken> => {
  const id = identifier(kind, userId);
  const raw = randomBytes(TOKEN_BYTE_LEN).toString("base64url");
  const tokenHash = hash(raw);
  const expiresAt = new Date(Date.now() + ttlFor(kind));

  await db.$transaction([
    db.verificationToken.deleteMany({ where: { identifier: id } }),
    db.verificationToken.create({
      data: { identifier: id, token: tokenHash, expires: expiresAt },
    }),
  ]);

  return { raw, expiresAt };
};

/**
 * Consumes a token. Returns the userId on success and deletes the row so it
 * cannot be reused. Returns null on any failure (unknown, expired, mismatch).
 */
export const consumeToken = async (
  kind: TokenKind,
  rawToken: string,
): Promise<string | null> => {
  if (!rawToken || rawToken.length < 16) return null;
  const tokenHash = hash(rawToken);

  // Find by stored hash; identifier carries the (kind, userId) tuple.
  const rows = await db.verificationToken.findMany({
    where: { token: tokenHash, identifier: { startsWith: `${kind}:` } },
  });

  // Constant-time comparison defends against the (unlikely) case of two rows
  // sharing a SHA-256 prefix in the DB index lookup; we still compare hashes
  // byte-by-byte to be safe.
  const row = rows.find((r) => {
    const a = Buffer.from(r.token, "hex");
    const b = Buffer.from(tokenHash, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  });

  if (!row) return null;
  if (row.expires.getTime() < Date.now()) {
    await db.verificationToken.delete({ where: { token: row.token } }).catch(() => {});
    return null;
  }

  // Single-use: remove on successful consumption.
  await db.verificationToken.delete({ where: { token: row.token } }).catch(() => {});

  const userId = row.identifier.slice(`${kind}:`.length);
  return userId || null;
};

export const buildVerifyUrl = (raw: string): string =>
  `${env.APP_URL.replace(/\/$/, "")}/verify?token=${encodeURIComponent(raw)}`;

export const buildResetUrl = (raw: string): string =>
  `${env.APP_URL.replace(/\/$/, "")}/reset/confirm?token=${encodeURIComponent(raw)}`;
