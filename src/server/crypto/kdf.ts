import argon2 from "argon2";

/**
 * Argon2id parameters tuned for ~250ms on a typical 2024 server CPU.
 * - memoryCost 64 MiB: forces attackers off commodity GPUs.
 * - timeCost 3: three passes over the memory.
 * - parallelism 1: single thread per hash; web requests don't share CPU well.
 *
 * If you change these, document the change in SECURITY.md and verify existing
 * hashes still re-verify (argon2.verify reads parameters from the encoded
 * hash, so they will).
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
};

/**
 * Hashes a password using Argon2id. Returns the standard PHC-formatted string
 * that includes the algorithm, parameters, salt, and hash — pass directly to
 * `verifyPassword` later.
 *
 * Throws on empty input — callers should validate length/complexity at the
 * schema layer; this function does not implement password policy.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length === 0) {
    throw new Error("kdf: refusing to hash an empty password");
  }
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Constant-time verification of a plaintext against a previously generated
 * Argon2 hash. Returns false (rather than throwing) for malformed hashes or
 * mismatched parameters, so authentication paths don't need to special-case
 * legacy formats.
 *
 * The work parameters are read from the encoded hash, so this remains valid
 * across parameter changes — re-hash on next login if the hash is below the
 * current minimum (see `needsRehash`).
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  if (plaintext.length === 0) return false;
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

/**
 * True if the stored hash's parameters are weaker than the current minimum.
 * Call after a successful verify to opportunistically upgrade the hash on the
 * next write (without forcing a password reset).
 */
export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, ARGON2_OPTIONS);
}
