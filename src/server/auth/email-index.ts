import { createHmac } from "node:crypto";

import { getMasterKey } from "@/server/crypto/key-source";

/**
 * Deterministic "blind index" for the email column.
 *
 * `User.email` is encrypted at rest (random IV per row, so the same email
 * produces different ciphertext each write) — which means you can't look a user
 * up by `WHERE email = …` anymore. The blind index solves that: a keyed,
 * deterministic HMAC of the normalized email, stored in its own `emailIndex`
 * column with a UNIQUE constraint. Exact-match lookups query `emailIndex`; the
 * encrypted `email` is only ever decrypted after the row is fetched.
 *
 * The HMAC key is DERIVED from the existing TOKEN_ENCRYPTION_KEY (domain-
 * separated), so enabling email encryption needs no new required env var and
 * can't drift out of sync with the master key. Because it's a keyed hash, an
 * attacker with only the database (and not the key) can't reverse it or test
 * candidate emails offline.
 */

let cachedKey: Buffer | null = null;

/** Subkey for the email index, derived from the master KEK via domain-separated HMAC. */
function indexKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = createHmac("sha256", getMasterKey())
    .update("rts:email-blind-index:v1")
    .digest();
  return cachedKey;
}

/** Canonical email form used both for storage and for index computation. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Compute the blind index for an email, or `null` for an absent/empty email
 * (Battle.net-only users have no email — they index to NULL, and Postgres
 * permits multiple NULLs under a unique index, so they never collide).
 */
export function emailBlindIndex(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const norm = normalizeEmail(email);
  if (norm.length === 0) return null;
  return createHmac("sha256", indexKey()).update(norm).digest("base64url");
}
