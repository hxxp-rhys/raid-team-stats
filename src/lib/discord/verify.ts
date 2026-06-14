import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * Verify a Discord interaction's Ed25519 signature over the RAW request body.
 * Discord signs `timestamp || rawBody` with the application's private key; we
 * verify with the public key (hex, from the Developer Portal).
 *
 * LOAD-BEARING: this is the auth boundary — we trust the signed
 * `member.user.id` only because this passed. The caller MUST pass the raw body
 * string (`await req.text()`), never a re-serialized JSON, or the bytes differ
 * and verification fails. Any failure (bad hex, wrong length, bad sig) → false;
 * Discord's routine invalid-signature probes are expected and return 401.
 */

// SPKI DER prefix wrapping a raw 32-byte Ed25519 public key:
//   SEQUENCE { SEQUENCE { OID 1.3.101.112 } BIT STRING(00 || key) }
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyInteractionSignature(
  rawBody: string,
  signatureHex: string | null,
  timestamp: string | null,
  publicKeyHex: string,
): boolean {
  if (!signatureHex || !timestamp || !publicKeyHex) return false;
  // Ed25519 sig = 64 bytes = 128 hex chars; public key = 32 bytes = 64 hex.
  if (!/^[0-9a-fA-F]{128}$/.test(signatureHex)) return false;
  if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    const message = Buffer.from(timestamp + rawBody, "utf8");
    const signature = Buffer.from(signatureHex, "hex");
    // Ed25519 takes no digest algorithm → pass null.
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}
