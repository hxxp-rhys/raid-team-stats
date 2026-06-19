import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { TOTP, Secret } from "otpauth";

import { siteConfig } from "@/lib/site-config";
import { env } from "@/env";
import { db } from "@/lib/db";
import { encryptToken, decryptToken } from "@/server/crypto/token-cipher";
import { hashPassword, verifyPassword } from "@/server/crypto/kdf";

/**
 * TOTP MFA (RFC 6238) using `otpauth`. The secret is stored AES-256-GCM-
 * encrypted in MfaSecret.secret. Recovery codes are 10 single-use 8-char
 * tokens, hashed with Argon2id (same KDF the user-password path uses) so a
 * leaked DB row reveals nothing useful.
 *
 * Step / digits / period match the defaults of every common authenticator
 * (Authy, 1Password, Google Authenticator, Bitwarden).
 */

const TOTP_ALGORITHM = "SHA1" as const;
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;
const RECOVERY_CODE_COUNT = 10;

function buildTotp(secretBase32: string, label: string): TOTP {
  return new TOTP({
    issuer: siteConfig.appName,
    label,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    secret: Secret.fromBase32(secretBase32),
  });
}

/**
 * Generates a fresh enrollment payload — the encrypted secret stays server-
 * side; the plain base32 and otpauth URL are sent to the client once to
 * render a QR code. Calling startEnrollment a second time invalidates the
 * previous pending enrollment.
 */
export async function startEnrollment(userId: string, label: string): Promise<{
  secretBase32: string;
  otpauthUrl: string;
}> {
  const secret = new Secret({ size: 20 }); // 160-bit per RFC 6238 §4
  const secretBase32 = secret.base32;
  const ciphertext = encryptToken(secretBase32)!;

  const totp = buildTotp(secretBase32, label);

  await db.mfaSecret.upsert({
    where: { userId },
    create: {
      userId,
      secret: ciphertext,
      recoveryCodes: [],
    },
    update: {
      secret: ciphertext,
      enabledAt: null,
      recoveryCodes: [],
    },
  });

  // The `otpauth://` standard has NO logo field, so the logo can only be
  // conveyed via the non-standard `image=` param (an absolute https URL to a
  // square PNG). Authenticator apps that support it (2FAS, Bitwarden, Ente)
  // fetch + show the brand logo; apps that don't (Google Authenticator,
  // Microsoft Authenticator, Authy) ignore it and just show the issuer name
  // ("Raid Team Stats"). The phone fetches this URL directly, so it must be a
  // public absolute URL (not affected by the site CSP). Built from the brand
  // logo (siteConfig.logoUrl) resolved against APP_URL.
  const logo = siteConfig.logoUrl;
  const logoUrl = /^https?:\/\//i.test(logo)
    ? logo
    : `${env.APP_URL.replace(/\/+$/, "")}/${logo.replace(/^\/+/, "")}`;
  const otpauthUrl = `${totp.toString()}&image=${encodeURIComponent(logoUrl)}`;
  return { secretBase32, otpauthUrl };
}

/**
 * Confirms enrollment: user supplies a TOTP from their authenticator; if it
 * matches we flip enabledAt and issue 10 recovery codes (returned ONCE).
 */
export async function confirmEnrollment(
  userId: string,
  code: string,
): Promise<{ recoveryCodes: string[] }> {
  const row = await db.mfaSecret.findUnique({ where: { userId } });
  if (!row) {
    throw new Error("No pending MFA enrollment; call startEnrollment first.");
  }
  const secretBase32 = decryptToken(row.secret);
  if (!secretBase32) throw new Error("Stored MFA secret is unreadable.");

  if (!verifyTotpCode(secretBase32, code)) {
    throw new Error("That code is incorrect or expired. Try again.");
  }

  const codes = await generateRecoveryCodes();

  await db.$transaction([
    db.mfaSecret.update({
      where: { userId },
      data: {
        enabledAt: new Date(),
        recoveryCodes: codes.hashes,
      },
    }),
    db.user.update({ where: { id: userId }, data: { mfaEnabled: true } }),
  ]);

  return { recoveryCodes: codes.plaintext };
}

/**
 * Disables MFA. Requires either a current TOTP code or a recovery code to
 * prevent attackers who hijacked a session from removing 2FA.
 */
export async function disable(
  userId: string,
  codeOrRecovery: string,
): Promise<void> {
  const verified = await verifyAnyMfaCode(userId, codeOrRecovery);
  if (!verified) {
    throw new Error("Code or recovery token rejected.");
  }
  await db.$transaction([
    db.mfaSecret.delete({ where: { userId } }),
    db.user.update({ where: { id: userId }, data: { mfaEnabled: false } }),
  ]);
}

/**
 * Returns true if the supplied 6-digit code matches the current TOTP value
 * for the user OR if it matches an unconsumed recovery code (which is then
 * marked consumed).
 */
export async function verifyAnyMfaCode(
  userId: string,
  raw: string,
): Promise<boolean> {
  const row = await db.mfaSecret.findUnique({ where: { userId } });
  if (!row || !row.enabledAt) return false;

  const trimmed = raw.replace(/\s+/g, "");
  if (!trimmed) return false;

  // First try TOTP.
  const secretBase32 = decryptToken(row.secret);
  if (secretBase32 && /^\d{6}$/.test(trimmed) && verifyTotpCode(secretBase32, trimmed)) {
    return true;
  }

  // Otherwise check recovery codes. Each is a single-use hashed value;
  // consume on match.
  for (const hashed of row.recoveryCodes) {
    if (await verifyPassword(hashed, trimmed)) {
      await db.mfaSecret.update({
        where: { userId },
        data: {
          recoveryCodes: row.recoveryCodes.filter((h) => h !== hashed),
        },
      });
      return true;
    }
  }
  return false;
}

function verifyTotpCode(secretBase32: string, code: string): boolean {
  const totp = buildTotp(secretBase32, "verify");
  // Allow a ±1-step skew (≈30s window each side) to tolerate clock drift.
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

async function generateRecoveryCodes(): Promise<{
  plaintext: string[];
  hashes: string[];
}> {
  const plaintext: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const bytes = randomBytes(5).toString("hex").toUpperCase(); // 10-char
    const formatted = `${bytes.slice(0, 5)}-${bytes.slice(5)}`;
    plaintext.push(formatted);
    hashes.push(await hashPassword(formatted));
  }
  return { plaintext, hashes };
}

/**
 * Stable-time check on whether a given user has MFA fully enabled. Cheap —
 * one indexed lookup. Auth.js's authorize() callback uses this.
 */
export async function isMfaEnabled(userId: string): Promise<boolean> {
  const row = await db.mfaSecret.findUnique({
    where: { userId },
    select: { enabledAt: true },
  });
  return !!row?.enabledAt;
}

// Helper for digestion of a token: used nowhere externally yet, kept to
// document the "never compare raw bytes" pattern Auth.js follows internally.
export const _stableTokenHash = (s: string) =>
  createHash("sha256").update(s).digest();
export const _timingSafeEq = (a: Buffer, b: Buffer) =>
  a.length === b.length && timingSafeEqual(a, b);
