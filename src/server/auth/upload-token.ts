import { createHash, randomBytes } from "node:crypto";

import { db } from "@/lib/db";

/**
 * Upload-token handling for the in-game addon / companion uploader.
 *
 * SECURITY: the token is a bearer credential. We persist only its SHA-256
 * (User.uploadToken), never the raw value — a DB leak no longer yields usable
 * tokens, and the raw token is shown to the user exactly once at (re)generation.
 *
 * ROLLING ROTATION (F8): on each accepted upload the server mints a fresh token
 * and demotes the old one to `uploadTokenPrev`. The previous token is honored
 * once (a grace window) so a dropped rotation response self-heals; the request
 * after that supersedes it. So a leaked token is invalidated by the owner's
 * normal use within ~one upload cycle. `uploadTokenRotatedAt` /
 * `uploadTokenLastUsedAt` surface staleness on the Account page.
 *
 * Pre-hardening rows hold the plaintext token; `resolveUploadTokenUserId`
 * accepts such a legacy value once and upgrades it to the hash in place.
 */

/** A fresh raw token (~43 url-safe chars). Shown to the user / companion once. */
export const newUploadToken = (): string => randomBytes(32).toString("base64url");

/** SHA-256 hex of a raw token — exactly what we store in the DB. */
export const hashUploadToken = (raw: string): string =>
  createHash("sha256").update(raw.trim()).digest("hex");

/**
 * Locate the owning user by the CURRENT hash, then the PREVIOUS hash (grace),
 * then a legacy plaintext row (migrated to the hash in place). Returns the row
 * id + its stored current token, or null. Pure lookup — does not rotate.
 */
async function findByToken(
  rawToken: string,
): Promise<{ id: string; uploadToken: string | null } | null> {
  const token = rawToken.trim();
  if (token.length < 16) return null;
  const hashed = hashUploadToken(token);

  const byHash = await db.user.findUnique({
    where: { uploadToken: hashed },
    select: { id: true, uploadToken: true },
  });
  if (byHash) return byHash;

  // Grace window: the just-rotated-away token is accepted one more time so a
  // dropped rotation response self-heals.
  const byPrev = await db.user.findUnique({
    where: { uploadTokenPrev: hashed },
    select: { id: true, uploadToken: true },
  });
  if (byPrev) return byPrev;

  // Legacy plaintext token (stored before hashing): accept once, then migrate.
  const byPlain = await db.user.findUnique({
    where: { uploadToken: token },
    select: { id: true, uploadToken: true },
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
  return { id: byPlain.id, uploadToken: hashed };
}

/**
 * Resolve the owning userId for a presented raw token, or null. Non-rotating —
 * used by the verify endpoint and by ingest authentication (ingest rotates
 * separately, only once the upload is actually accepted).
 */
export async function resolveUploadTokenUserId(
  rawToken: string,
): Promise<string | null> {
  return (await findByToken(rawToken))?.id ?? null;
}

/**
 * Mint a new token for `userId`, demote the current one to `uploadTokenPrev`
 * (one-use grace), and stamp rotated/last-used. Returns the new RAW token for
 * the companion to persist. Call only after an upload is accepted.
 */
export async function rotateUploadToken(userId: string): Promise<string> {
  const nextRaw = newUploadToken();
  const now = new Date();
  const current = await db.user.findUnique({
    where: { id: userId },
    select: { uploadToken: true },
  });
  await db.user.update({
    where: { id: userId },
    data: {
      uploadTokenPrev: current?.uploadToken ?? null,
      uploadToken: hashUploadToken(nextRaw),
      uploadTokenRotatedAt: now,
      uploadTokenLastUsedAt: now,
    },
  });
  return nextRaw;
}
