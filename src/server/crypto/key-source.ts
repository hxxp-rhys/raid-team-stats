import { env } from "@/env";

/**
 * Decodes and validates the master key-encryption-key (KEK) from environment.
 * The KEK is used to encrypt OAuth tokens at the column level (defense in depth
 * on top of database-level encryption at rest).
 *
 * Format: TOKEN_ENCRYPTION_KEY is a base64-encoded 32-byte (256-bit) value.
 * Generate via `openssl rand -base64 32`.
 *
 * The key is loaded once at module import. Rotation requires a re-encryption
 * pass over every Account row (Phase 2.x — operational procedure documented in
 * SECURITY.md when the rotation script lands).
 */
const decoded = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64");

if (decoded.length !== 32) {
  throw new Error(
    `TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${decoded.length}). ` +
      `Generate with: openssl rand -base64 32`,
  );
}

export const masterKey: Buffer = decoded;

/**
 * Version byte for the cipher envelope. Bumping this signals a key/algorithm
 * rotation; the cipher module reads the version to select the right decrypt
 * path during transitional periods.
 */
export const CIPHER_VERSION = 0x01;
