import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getMasterKey, CIPHER_VERSION } from "@/server/crypto/key-source";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit IV recommended for GCM
const TAG_LEN = 16; // 128-bit authentication tag

/**
 * Encrypts a plaintext string using AES-256-GCM with a random per-message IV.
 *
 * Output envelope (base64-encoded):
 *   byte 0:        version (one byte)
 *   bytes 1..12:   IV (12 bytes)
 *   bytes 13..28:  auth tag (16 bytes)
 *   bytes 29..end: ciphertext
 *
 * Inputs of null/undefined return null — useful when the cipher is applied
 * via a Prisma client extension over nullable columns (Account.refresh_token,
 * Account.access_token, etc.).
 */
export function encryptToken(plaintext: string | null | undefined): string | null {
  if (plaintext == null) return null;

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, getMasterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope = Buffer.alloc(1 + IV_LEN + TAG_LEN + encrypted.length);
  envelope[0] = CIPHER_VERSION;
  iv.copy(envelope, 1);
  tag.copy(envelope, 1 + IV_LEN);
  encrypted.copy(envelope, 1 + IV_LEN + TAG_LEN);

  return envelope.toString("base64");
}

/**
 * Decrypts a base64-encoded ciphertext produced by `encryptToken`. Returns null
 * for null/undefined input. Throws on malformed input, unsupported version, or
 * authentication-tag mismatch (tampering / wrong key).
 */
export function decryptToken(ciphertext: string | null | undefined): string | null {
  if (ciphertext == null) return null;

  const envelope = Buffer.from(ciphertext, "base64");
  if (envelope.length < 1 + IV_LEN + TAG_LEN) {
    throw new Error("token-cipher: ciphertext too short to be a valid envelope");
  }

  const version = envelope[0];
  if (version !== CIPHER_VERSION) {
    throw new Error(`token-cipher: unsupported cipher version ${version}`);
  }

  const iv = envelope.subarray(1, 1 + IV_LEN);
  const tag = envelope.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct = envelope.subarray(1 + IV_LEN + TAG_LEN);

  const decipher = createDecipheriv(ALGO, getMasterKey(), iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * True when the value looks like a valid cipher envelope. Used by the Prisma
 * extension to detect already-encrypted values during writes (idempotence) and
 * during reads (transitional periods when the table contains both forms).
 */
export function isEncrypted(value: string | null | undefined): boolean {
  if (value == null) return false;
  try {
    const buf = Buffer.from(value, "base64");
    return buf.length >= 1 + IV_LEN + TAG_LEN && buf[0] === CIPHER_VERSION;
  } catch {
    return false;
  }
}
