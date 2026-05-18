import { createHash, randomBytes } from "node:crypto";

import { db } from "@/lib/db";

/**
 * Upload-token handling for the in-game addon / companion uploader.
 *
 * SECURITY: the token is a bearer credential. We persist only its
 * SHA-256 (User.uploadToken), never the raw value — a DB leak no longer
 * yields usable tokens, and the raw token is shown to the user exactly
 * once at (re)generation.
 *
 * Pre-hardening rows hold the plaintext token. `resolveUploadTokenUserId`
 * accepts such a legacy value once and upgrades it to the hash in place,
 * so existing companions keep working with no flag day / migration.
 */

/** A fresh raw token (~43 url-safe chars). Shown to the user once. */
export const newUploadToken = (): string =>
  randomBytes(32).toString("base64url");

/** SHA-256 hex of a raw token — exactly what we store in the DB. */
export const hashUploadToken = (raw: string): string =>
  createHash("sha256").update(raw.trim()).digest("hex");

/**
 * Resolve the owning userId for a presented raw token, or null.
 * Tries the hash first; falls back to a legacy plaintext row and
 * transparently upgrades it to the hash (idempotent under races).
 */
export async function resolveUploadTokenUserId(
  rawToken: string,
): Promise<string | null> {
  const token = rawToken.trim();
  if (token.length < 16) return null;

  const hashed = hashUploadToken(token);
  const byHash = await db.user.findUnique({
    where: { uploadToken: hashed },
    select: { id: true },
  });
  if (byHash) return byHash.id;

  // Legacy plaintext token (stored before hashing): accept once, then
  // migrate the row to the hash so it's never readable in cleartext again.
  const byPlain = await db.user.findUnique({
    where: { uploadToken: token },
    select: { id: true },
  });
  if (!byPlain) return null;
  try {
    await db.user.update({
      where: { id: byPlain.id },
      data: { uploadToken: hashed },
    });
  } catch {
    /* another concurrent request already migrated it — fine */
  }
  return byPlain.id;
}
